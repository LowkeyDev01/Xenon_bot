import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { onlineDBClient as pool } from './db.js';

let lastUID = 0;
let emailListenerStarted = false;

// YOUR ORIGINAL WORKING REGEX LOGIC - UNTOUCHED
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
    const client = createClient();

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        // Clean search criteria
        const searchCriteria = { from: 'moniepoint', seen: false };
        const messages = client.fetch(searchCriteria, { source: true, uid: true });

        // Array to collect UIDs that successfully matched and updated the database
        const uidsToMarkAsSeen = [];

        for await (const msg of messages) {
            if (msg.uid <= lastUID) continue; 
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

            console.log(`✅ Payment matched! wa_id: ${rows[0].wa_id}`);
            
            // Push the UID to the array instead of executing client.messageFlagsAdd inside the stream
            uidsToMarkAsSeen.push(msg.uid);
        }

        // FIXED: Mark them all as SEEN at once after the live data stream is closed
        if (uidsToMarkAsSeen.length > 0) {
            await client.messageFlagsAdd({ uid: uidsToMarkAsSeen }, ['\\Seen']);
            console.log(`🏁 Successfully marked UIDs [${uidsToMarkAsSeen.join(', ')}] as SEEN.`);
        }

    } catch (err) {
        console.error('Email Listener Error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
    }
}

// Loop worker using safe setTimeout to ensure cycles never overlap or jam connections
async function runLoop() {
    await processNewEmails();
    setTimeout(runLoop, 30 * 1000);
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

    runLoop();
}
