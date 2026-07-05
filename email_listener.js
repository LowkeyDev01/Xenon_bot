import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { onlineDBClient as pool } from './db.js';

let lastUID = 0;
let emailListenerStarted = false;

function extractPaymentDetails(text) {
    // Collapse all HTML spacing fragments, line breaks, and tabs into a single clean line string
    const cleanText = text.replace(/\s+/g, ' ').trim();
    
    // Debug log to trace matching text in your server stdout
    console.log("🔍 Cleaned Email Text for matching:", cleanText);

    // Matches Moniepoint receipt structures resiliently regardless of changing layout nodes
    const amountMatch = cleanText.match(/Credit Amount\s*[:\-]?\s*([0-9,]+\.[0-9]{2})/i);
    const senderMatch = cleanText.match(/Sender(?:'s)?\s*Name\s*[:\-]?\s*(?:from\s+)?([^|]+)/i);
    const dateTimeMatch = cleanText.match(/Date\s*&\s*Time\s*[:\-]?\s*([^|]+)\|([^|\n]+)/i);

    if (!amountMatch) return null;

    return {
        amount: parseFloat(amountMatch[1].replace(/,/g, '')),
        senderName: senderMatch ? senderMatch[1].trim() : 'Unknown Sender',
        date: dateTimeMatch ? dateTimeMatch[1].trim() : new Date().toLocaleDateString(),
        time: dateTimeMatch ? dateTimeMatch[2].trim() : new Date().toLocaleTimeString(),
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
        logger: false,
        connectionTimeout: 15000,
        greetingTimeout: 15000
    });
}

async function processNewEmails() {
    const client = createClient();

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        const searchCriteria = { from: 'moniepoint', seen: false };
        const messages = client.fetch(searchCriteria, { source: true, uid: true });

        // Batch collector to safely execute flags after the live stream closes
        const uidsToMarkAsSeen = [];

        for await (const msg of messages) {
            if (msg.uid <= lastUID) continue; 
            if (msg.uid > lastUID) lastUID = msg.uid;

            console.log(`📧 Found new unread Moniepoint email! UID: ${msg.uid}`);

            const parsed = await simpleParser(msg.source);
            
            let body = parsed.text || '';
            if (!body && parsed.html) {
                body = parsed.html.replace(/<[^>]*>/g, ' ');
            }

            const details = extractPaymentDetails(body);

            if (!details) {
                console.log('⚠️ Could not match pattern fields inside this email.');
                continue;
            }

            console.log(`💰 Payment parsed: ₦${details.amount} from ${details.senderName}`);

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
                console.log(`⚠️ No active pending database record matched for exactly ₦${details.amount}`);
                continue;
            }

            console.log(`✅ Database Updated successfully! WhatsApp ID: ${rows[0].wa_id}`);
            uidsToMarkAsSeen.push(msg.uid);
        }

        // Apply SEEN status outside the fetch iteration loop to avoid stream collision deadlocks
        if (uidsToMarkAsSeen.length > 0) {
            await client.messageFlagsAdd({ uid: uidsToMarkAsSeen }, ['\\Seen']);
            console.log(`🏁 Successfully marked UIDs [${uidsToMarkAsSeen.join(', ')}] as SEEN.`);
        }

    } catch (err) {
        console.error('❌ Email Processing Error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
    }
}

async function runLoop() {
    try {
        await processNewEmails();
    } catch (e) {
        console.error("Loop Execution Error:", e.message);
    }
    setTimeout(runLoop, 20 * 1000); 
}

export async function startEmailListener() {
    if (emailListenerStarted) return;
    emailListenerStarted = true;

    console.log('📧 Booting up IMAP Email Listener Connection...');

    const client = createClient();
    try {
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        lastUID = mailbox.uidNext - 1;
        console.log(`📡 Connection active. Watching inbox starting above UID: ${lastUID}`);
    } catch (err) {
        console.error('❌ IMAP Initialization failed:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
    }

    runLoop();
}
