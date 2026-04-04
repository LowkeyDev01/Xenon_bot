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

// ── GLOBAL STATE ───────────────────────────────────────────
let sock = null; // Global socket reference
let expiryJobStarted = false;

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
    const usedKobos = new Set(rows.map(r => Math.round((parseFloat(r.amount) % 1) * 100)));
    for (let kobo = 1; kobo <= 99; kobo++) {
        if (!usedKobos.has(kobo)) return baseAmount + (kobo / 100);
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
async function startExpiryJob() {
    if (expiryJobStarted) return;
    expiryJobStarted = true;

    setInterval(async () => {
        if (!sock) return; // Wait until socket is initialized
        console.log('🔄 Expiry job running...');
        try {
            // REMINDER
            const { rows: reminders } = await pool.query(
                `SELECT wa_id, amount FROM pending_payments
                 WHERE status = 'pending'
                 AND created_at < NOW() - INTERVAL '9 minutes'
                 AND created_at > NOW() - INTERVAL '11 minutes'`
            );

            for (const row of reminders) {
                const jid = `${row.wa_id}@s.whatsapp.net`;
                await sock.sendMessage(jid, {
                    text: `⚠️ *Payment Reminder*\n\nYour order for *₦${Number(row.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}* expires in *5 minutes*!`
                }).catch(e => console.log("Reminder send failed:", e.message));
            }

            // EXPIRE
            const { rows: expired } = await pool.query(
                `UPDATE pending_payments SET status = 'expired'
                 WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'
                 RETURNING wa_id, amount`
            );

            for (const row of expired) {
                const jid = `${row.wa_id}@s.whatsapp.net`;
                await sock.sendMessage(jid, {
                    text: `⏰ *Order Expired*\n\nYour payment request for *₦${Number(row.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}* has expired.`
                }).catch(e => console.log("Expiry send failed:", e.message));
            }
        } catch (err) {
            console.error('Expiry Job Error:', err.message);
        }
    }, 60 * 1000);
}

// ── WHATSAPP CONNECTION ────────────────────────────────────
async function connectToWhatsApp() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const { state, saveCreds } = await usePostgresAuthState();

    // Initialize global sock
    sock = makeWASocket({
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
            console.log('\n--- SCAN QR CODE ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ XENON BOT IS ONLINE!');
            startExpiryJob();
            startEmailListener(sock); // Ensure email listener uses the active sock
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const waId = sender.split('@')[0];
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

        // COMMAND: BUY
        if (text === 'buy') {
            try {
                const { rows: existing } = await pool.query(
                    `SELECT * FROM pending_payments WHERE wa_id = $1 AND status = 'pending' LIMIT 1`, [waId]
                );

                if (existing.length > 0) {
                    return await sock.sendMessage(sender, { 
                        text: `⚠️ You already have a pending order for *₦${Number(existing[0].amount).toLocaleString('en-NG')}*.` 
                    });
                }

                const amount = await createPendingPayment(waId);
                await sock.sendMessage(sender, {
                    text: `🚀 *Xenon Payment*\n\nTransfer exactly *₦${amount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}* to:\n\nBank: *Moniepoint*\nAcc: *8137811382*\nName: *Kehinde Kayode Ariyibi-Busuyi*`
                });
            } catch (err) {
                console.error('Buy Error:', err);
            }
        }

        // COMMAND: PAID
        if (text === 'paid') {
            const { rows } = await pool.query(`SELECT * FROM pending_payments WHERE wa_id = $1 ORDER BY created_at DESC LIMIT 1`, [waId]);
            if (rows.length === 0) return;

            const order = rows[0];
            if (order.status === 'pending') {
                await sock.sendMessage(sender, { text: `⏳ Payment not found yet. Please wait 2-5 mins for banks to sync.` });
            } else if (order.status === 'paid') {
                await sock.sendMessage(sender, { text: `✅ Already confirmed! Processing your order.` });
            }
        }

        // COMMAND: CANCEL
        if (text === 'cancel') {
            await pool.query(`UPDATE pending_payments SET status = 'cancelled' WHERE wa_id = $1 AND status = 'pending'`, [waId]);
            await sock.sendMessage(sender, { text: `✅ Order cancelled.` });
        }
    });
}

connectToWhatsApp().catch(err => console.log('Unexpected error: ' + err));