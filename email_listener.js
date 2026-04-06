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
    const amountMatch = text.match(/Credit Amount\s*\n\s*([0-9,]+\.[0-9]{2})/i);
    const senderMatch = text.match(/Sender's Name:\s*\n\s*from (.+)/i);
    const dateTimeMatch = text.match(/Date & Time:\s*\n\s*(.+)\s*\|\s*(.+)/i);

    if (!amountMatch) return null;

    return {
        amount: parseFloat(amountMatch[1].replace(/,/g, '')),
        senderName: senderMatch ? senderMatch[1].trim() : null,
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
        await client.mailboxOpen('INBOX');

        const searchCriteria = lastUID > 0
            ? { from: 'moniepoint', seen: false, uid: `${lastUID + 1}:*` }
            : { from: 'moniepoint', seen: false };

        const messages = client.fetch(searchCriteria, { source: true, uid: true });

        for await (const msg of messages) {
            if (msg.uid > lastUID) lastUID = msg.uid;

            const parsed = await simpleParser(msg.source);
            let body = parsed.text || '';
            if (!body && parsed.html) {
                body = parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            }

            const details = extractPaymentDetails(body);

            if (!details) {
                console.log('⚠️ Could not extract payment details from email.');
                continue;
            }

            console.log(`💰 Payment detected: ₦${details.amount} from ${details.senderName} on ${details.date} at ${details.time}`);

            const { rows } = await pool.query(
                `UPDATE pending_payments
                 SET status = 'paid',
                     date_paid = $2,
                     time_paid = $3,
                     sender_name = $4
                 WHERE amount = $1 AND status = 'pending'
                 RETURNING wa_id, amount`,
                [details.amount, details.date, details.time, details.senderName]
            );

            if (rows.length === 0) {
                console.log(`⚠️ No pending order found for ₦${details.amount}`);
                continue;
            }

            console.log(`✅ Matched! wa_id: ${rows[0].wa_id}`);

            const jid = buildJid(rows[0].wa_id);
            await currentSock.sendMessage(jid, {
                text: `✅ *Payment Confirmed!*\n\n` +
                    `We've received your payment of *₦${Number(rows[0].amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}*.\n\n` +
                    `Your order is being processed. 🎉`
            });

            await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        }
    } catch (err) {
        console.error('Email Listener Error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
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
        } catch (_) {}
    }

    setInterval(() => processNewEmails(), 30 * 1000);
}