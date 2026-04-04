import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { onlineDBClient as pool } from './db.js';
const APP_START_TIME = new Date();

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

async function processNewEmails(sock) {
    const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        },
        logger: false
    });

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        const since = new Date(APP_START_TIME);
        since.setMinutes(since.getMinutes() - 1);

        const messages = client.fetch(
            { from: 'moniepoint', seen: false, since },
            { source: true }
        );

        for await (const msg of messages) {
            const parsed = simpleParser(msg.source);
            const body = parsed.text || '';

            console.log('RAW BODY:', body);

            const details = extractPaymentDetails(body);

             console.log('Extracted details:', details);

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

            console.log(`✅ Matched! wa_id: ${rows[0].wa_id}, sender: ${details.senderName}`);

            const jid = `${rows[0].wa_id}@s.whatsapp.net`;
            await sock.sendMessage(jid, {
                text: `✅ *Payment Confirmed!*\n\n` +
                    `We've received your payment of *₦${Number(rows[0].amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}*.\n\n` +
                    `Your order is being processed. 🎉`
            });

            await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        }
    } catch (err) {
        console.error('Email Listener Error:', err);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {
            // connection already gone, ignore
        }
    }
}

export async function startEmailListener(sock) {
    console.log('📧 Email listener started...');
    await processNewEmails(sock);
    setInterval(() => processNewEmails(sock), 30 * 1000);
}