import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { onlineDBClient as pool } from './db.js';

let lastUID = 0;
let emailListenerStarted = false;
let currentSock = null;

export function updateSock(sock) {
    currentSock = sock;
}

function buildJid(waId) {
    if (waId.includes('@')) return waId;
    return `${waId}@s.whatsapp.net`;
}

function extractPaymentDetails(text) {
    // UPDATED REGEX: Specifically looks for "Credit" and handles decimals (1000.01 - 1000.99)
    if (!text.includes('Credit')) return null;
    
    const amountMatch = text.match(/Credit Amount\s*[:\n\r]*\s*([0-9,]+\.[0-9]{2})/i);
    const senderMatch = text.match(/Sender's Name:\s*(?:from\s+)?(.+)/i);
    const dateTimeMatch = text.match(/Date & Time:\s*(.+)\s*\|\s*(.+)/i);

    if (!amountMatch) return null;

    return {
        amount: parseFloat(amountMatch[1].replace(/,/g, '')),
        senderName: senderMatch ? senderMatch[1].trim() : "Unknown",
        date: dateTimeMatch ? dateTimeMatch[1].trim() : null,
        time: dateTimeMatch ? dateTimeMatch[2].trim() : null,
    };
}

function createClient() {
    return new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        },
        logger: false
    });
}

async function processNewEmails() {
    if (!currentSock) return;
    const client = createClient();

    try {
        await client.connect();
        // FIX 1: Lock the mailbox so we can mark as read while looping
        let lock = await client.getMailboxLock('INBOX');

        try {
            const searchCriteria = lastUID > 0
                ? { from: 'no-reply@moniepoint.com', seen: false, uid: `${lastUID + 1}:*` }
                : { from: 'no-reply@moniepoint.com', seen: false };

            // FIX 2: Use fetchAll to prevent connection deadlocks during loops
            const messages = await client.fetchAll(searchCriteria, { source: true, uid: true });

            for (const msg of messages) {
                if (msg.uid > lastUID) lastUID = msg.uid;

                const parsed = await simpleParser(msg.source);
                let body = parsed.text || '';
                if (!body && parsed.html) {
                    body = parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                }
                
                // FIX 3: Split body to only look at the newest part of a threaded email
                const newestPart = body.split(/On\s.*\swrote:|From:/i)[0];
                const details = extractPaymentDetails(newestPart);

                if (!details) {
                    console.log('⚠️ Not a credit alert or format changed. Marking read.');
                    await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
                    continue;
                }

                console.log(`💰 Payment detected: ₦${details.amount} from ${details.senderName}`);

                const { rows } = await pool.query(
                    `UPDATE pending_payments
                     SET status = 'paid', date_paid = $2, time_paid = $3, sender_name = $4
                     WHERE amount = $1 AND status = 'pending'
                     RETURNING wa_id, amount`,
                    [details.amount, details.date, details.time, details.senderName]
                );

                if (rows.length === 0) {
                    console.log(`⚠️ No pending order found for ₦${details.amount}. Marking read.`);
                    // LOG UNMATCHED: Optional, but keeps the flow going
                    await pool.query('INSERT INTO dead_payments (uid, amount, sender_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [msg.uid, details.amount, details.senderName]);
                    await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
                    continue;
                }

                const wa_id = rows[0].wa_id;
                const jid = buildJid(wa_id);

                console.log(`✅ Matched! wa_id: ${wa_id}`);

                const updateResult = await pool.query(
                    `UPDATE codes SET is_bought = true, bought_at = NOW(), wa_id = $1 
                     WHERE code_string = (
                         SELECT code_string FROM codes 
                         WHERE is_bought = false AND account_type = 'USER' 
                         FOR UPDATE SKIP LOCKED LIMIT 1
                     ) RETURNING code_string`,
                    [wa_id]
                );

                if (updateResult.rows.length === 0) {
                    await currentSock.sendMessage(jid, {
                        text: `❌ No codes available at the moment. Please contact support.`
                    });
                    // Still mark as read so we don't try again until they contact support
                    await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
                    continue;
                }

                const code = updateResult.rows[0].code_string;

                await currentSock.sendMessage(jid, {
                    text: `✅ *Payment Confirmed!*\n\n` +
                        `We've received your payment of *₦${Number(rows[0].amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}*.\n\n` +
                        `Your order is being processed. 🎉`
                });

                await currentSock.sendMessage(jid, {
                    text: `🎉 *Your Code*\n\nKeep it safe!`
                });
                await currentSock.sendMessage(jid, {
                    text: `*${code}*`
                });

                // FIX 4: Log to processed_emails and mark as Read
                await pool.query('INSERT INTO processed_emails (uid, amount, sender_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [msg.uid, details.amount, details.senderName]);
                await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
            }
        } finally {
            lock.release(); // FIX 5: Always release the lock
        }
    } catch (err) {
        console.error('Email Listener Error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) { }
    }
}

export async function startEmailListener() {
    if (emailListenerStarted) return;
    emailListenerStarted = true;

    console.log('📧 Email listener started...');

    const client = createClient();
    try {
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        lastUID = mailbox.uidNext - 1;
        console.log(`📧 Starting from UID: ${lastUID}`);
    } catch (err) {
        console.error('Email init error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) { }
    }

    setInterval(() => processNewEmails(), 30 * 1000);
}