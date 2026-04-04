import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { onlineDBClient as pool } from './db.js';
import { startEmailListener } from './email_listener.js';
import { usePostgresAuthState } from './auth.js';
import http from 'http';

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err?.message);
});

// ── KEEP ALIVE ─────────────────────────────────────────────
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Xenon bot is alive!');
}).listen(process.env.PORT || 5000, () => {
    console.log(`🌐 Server running on port ${process.env.PORT || 5000}`);
});

// ── KOBO LOGIC ─────────────────────────────────────────────
async function assignUniqueAmount(baseAmount = 1000) {
    const { rows } = await pool.query(
        `SELECT amount FROM pending_payments 
         WHERE created_at > NOW() - INTERVAL '15 minutes'`
    );

    const usedKobos = new Set(rows.map(r => Math.round((r.amount % 1) * 100)));

    for (let kobo = 1; kobo <= 99; kobo++) {
        if (!usedKobos.has(kobo)) {
            return baseAmount + (kobo / 100);
        }
    }

    throw new Error('All kobo slots taken.');
}

async function createPendingPayment(waId) {
    const amount = await assignUniqueAmount();

    await pool.query(
        `INSERT INTO pending_payments (wa_id, amount) VALUES ($1, $2)`,
        [waId, amount]
    );

    return amount;
}

// ── EXPIRY JOB ─────────────────────────────────────────────
let expiryJobStarted = false;

async function startExpiryJob(sock) {
    if (expiryJobStarted) return;
    expiryJobStarted = true;

    setInterval(async () => {
        console.log('🔄 Expiry job running...');
        try {
            // ── REMINDER at 10 mins ────────────────────────
            const { rows: reminders } = await pool.query(
                `SELECT wa_id, amount FROM pending_payments
                 WHERE status = 'pending'
                 AND created_at < NOW() - INTERVAL '9 minutes'
                 AND created_at > NOW() - INTERVAL '11 minutes'`
            );

            console.log('Reminders found:', reminders.length, reminders);

            for (const row of reminders) {
                try {
                    const jid = `${row.wa_id}@s.whatsapp.net`;
                    await sock.sendMessage(jid, {
                        text: `⚠️ *Payment Reminder*\n\n` +
                            `Your order for *₦${Number(row.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}* expires in *5 minutes*!\n\n` +
                            `Please complete your transfer now or send *cancel* to cancel.`
                    });
                } catch (err) {
                    console.error('Reminder send failed:', err.message);
                }
            }

            // ── EXPIRE at 15 mins ──────────────────────────
            const { rows: expired } = await pool.query(
                `UPDATE pending_payments 
                 SET status = 'expired'
                 WHERE status = 'pending'
                 AND created_at < NOW() - INTERVAL '15 minutes'
                 RETURNING wa_id, amount`
            );

            for (const row of expired) {
                try {
                    const jid = `${row.wa_id}@s.whatsapp.net`;
                    await sock.sendMessage(jid, {
                        text: `⏰ *Order Expired*\n\n` +
                            `Your payment request for *₦${Number(row.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}* has expired.\n\n` +
                            `Send *buy* to start a new order.`
                    });
                } catch (err) {
                    console.error('Expiry send failed:', err.message);
                }
            }
        } catch (err) {
            console.error('Expiry Job Error:', err.message);
        }
    }, 60 * 1000);
}

// ── WHATSAPP ───────────────────────────────────────────────
async function connectToWhatsApp() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const { state, saveCreds } = await usePostgresAuthState();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: (await import('pino')).default({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
            console.log('----------------------------------------\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reason:', lastDisconnect.error?.message, 'Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('❌ Logged out. Delete "auth_info_baileys" and scan again.');
            }
        } else if (connection === 'open') {
            console.log('✅ XENON BOT IS ONLINE AND CONNECTED!');
            startExpiryJob(sock);
            startEmailListener(sock);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const waId = sender.split('@')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // ── COMMAND: BUY ───────────────────────────────────
        if (text?.toLowerCase() === 'buy') {
            try {
                const { rows: existing } = await pool.query(
                    `SELECT * FROM pending_payments 
                     WHERE wa_id = $1 AND status = 'pending'
                     ORDER BY created_at DESC LIMIT 1`,
                    [waId]
                );

                if (existing.length > 0) {
                    const displayAmount = Number(existing[0].amount).toLocaleString('en-NG', { minimumFractionDigits: 2 });
                    return await sock.sendMessage(sender, {
                        text: `⚠️ You already have a pending order for *₦${displayAmount}*.\n\n` +
                            `Please complete the payment and send *paid* to confirm.\n\n` +
                            `To cancel and start a new order, send *cancel*.`
                    });
                }

                const amount = await createPendingPayment(waId);
                const displayAmount = amount.toLocaleString('en-NG', { minimumFractionDigits: 2 });

                await sock.sendMessage(sender, {
                    text: `🚀 *Xenon Payment Request*\n\n` +
                        `Please transfer exactly *₦${displayAmount}* to:\n\n` +
                        `Bank: *Moniepoint*\n` +
                        `Account: *1234567890*\n` +
                        `Name: *Your Name*\n\n` +
                        `⚠️ *IMPORTANT:* Transfer the *EXACT* amount (including the kobos) so the system can verify you instantly!\n\n` +
                        `⏰ This order expires in *15 minutes*.\n\n` +
                        `Once done, send *paid* to confirm.`
                });
            } catch (err) {
                console.error('Buy Error:', err);
                await sock.sendMessage(sender, {
                    text: '⚠️ System is busy. Please try again in a few minutes.'
                });
            }
        }

        // ── COMMAND: CANCEL ────────────────────────────────
        if (text?.toLowerCase() === 'cancel') {
            try {
                const { rows } = await pool.query(
                    `UPDATE pending_payments SET status = 'cancelled'
                     WHERE wa_id = $1 AND status = 'pending'
                     RETURNING amount`,
                    [waId]
                );

                if (rows.length === 0) {
                    return await sock.sendMessage(sender, {
                        text: `❌ No pending order to cancel. Send *buy* to start.`
                    });
                }

                await sock.sendMessage(sender, {
                    text: `✅ Order cancelled. Send *buy* to start a new one.`
                });
            } catch (err) {
                console.error('Cancel Error:', err);
                await sock.sendMessage(sender, {
                    text: '⚠️ Something went wrong. Please try again.'
                });
            }
        }

        // ── COMMAND: PAID ──────────────────────────────────
        if (text?.toLowerCase() === 'paid') {
            try {
                const { rows } = await pool.query(
                    `SELECT * FROM pending_payments 
                     WHERE wa_id = $1
                     ORDER BY created_at DESC LIMIT 1`,
                    [waId]
                );

                if (rows.length === 0) {
                    return await sock.sendMessage(sender, {
                        text: `❌ No order found. Send *buy* to start.`
                    });
                }

                const order = rows[0];

                if (order.status === 'paid') {
                    return await sock.sendMessage(sender, {
                        text: `✅ Your payment of *₦${Number(order.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}* was already confirmed! Your order is being processed. 🎉`
                    });
                }

                if (order.status === 'expired') {
                    return await sock.sendMessage(sender, {
                        text: `⏰ Your order expired. Send *buy* to start a new one.`
                    });
                }

                if (order.status === 'cancelled') {
                    return await sock.sendMessage(sender, {
                        text: `❌ Your order was cancelled. Send *buy* to start a new one.`
                    });
                }

                // Still pending
                await sock.sendMessage(sender, {
                    text: `⏳ Payment not found yet. Banks can take 2-5 mins to sync.\n\nPlease send *paid* again shortly.`
                });
            } catch (err) {
                console.error('Paid Error:', err);
                await sock.sendMessage(sender, {
                    text: '⚠️ Something went wrong. Please try again.'
                });
            }
        }
    });
}

connectToWhatsApp().catch(err => console.log('Unexpected error: ' + err));