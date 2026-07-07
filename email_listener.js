import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { onlineDBClient as pool } from './db.js';

let lastUID = 0;
let emailListenerStarted = false;

// ── REGEX EXTRACTION ENGINE ─────────────────────────────────
function extractPaymentDetails(text) {
    const amountMatch = text.match(
        /Credit Amount\s*\n\s*([0-9,]+\.[0-9]{2})/i
    );
    const senderMatch = text.match(
        /Sender's Name:\s*\n\s*from (.+)/i
    );
    const dateTimeMatch = text.match(
        /Date & Time:\s*\n\s*(.+)\s*\|\s*(.+)/i
    );

    if (!amountMatch) return null;

    return {
        amount: parseFloat(amountMatch[1].replace(/,/g, '')),
        senderName: senderMatch ? senderMatch[1].trim() : null,
        date: dateTimeMatch ? dateTimeMatch[1].trim() : null,
        time: dateTimeMatch ? dateTimeMatch[2].trim() : null,
    };
}

// ── IMAP CLIENT CONFIGURATION ───────────────────────────────
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

// ── STREAM PROCESSOR ────────────────────────────────────────
async function processNewEmails() {
    const client = createClient();

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        // Target fresh UIDs since the last check execution cycle
        const messages = await client.fetch(
            { uid: `${lastUID + 1}:*` }, 
            {
                uid: true,
                source: true,
                bodyStructure: true
            }
        );

        const uidsToMarkAsSeen = [];

        for await (const msg of messages) {
            if (msg.uid > lastUID) lastUID = msg.uid;

            const parsed = await simpleParser(msg.source);
            const textContent = parsed.text || parsed.textAsHtml;
            const payment = extractPaymentDetails(textContent);

            if (!payment) continue;

            console.log(
                `📩 Found matching email for amount: ₦${payment.amount}`
            );

            // 1. Update status inside pending_payments table
            const { rows } = await pool.query(
                `UPDATE pending_payments
                 SET status = 'paid', 
                     date_paid = $1, 
                     time_paid = $2, 
                     sender_name = $3
                 WHERE amount = $4 AND status = 'pending'
                 RETURNING wa_id`,
                [
                    payment.date, 
                    payment.time, 
                    payment.senderName, 
                    payment.amount
                ]
            );

            // 2. Immediately allocate code asset if a pending record matches
            if (rows.length > 0) {
                const phone = rows[0].wa_id;
                console.log(`✅ Match identified for user: ${phone}`);

                const codeUpdate = await pool.query(
                    `UPDATE codes 
                     SET is_bought = true, 
                         bought_at = NOW(), 
                         wa_id = $1 
                     WHERE code_string = (
                         SELECT code_string FROM codes 
                         WHERE is_bought = false 
                         AND account_type = 'USER' 
                         FOR UPDATE SKIP LOCKED LIMIT 1
                     ) RETURNING code_string`,
                    [phone]
                );

                if (codeUpdate.rows[0]) {
                    console.log(
                        `🔑 Linked code [${codeUpdate.rows[0].code_string}] to ${phone}`
                    );
                } else {
                    console.log(
                        `⚠️ Payment logged, but code inventory pool is empty!`
                    );
                }

                uidsToMarkAsSeen.push(msg.uid);
            }
        }

        // 3. Clean up and mark processed messages as seen
        if (uidsToMarkAsSeen.length > 0) {
            await client.messageFlagsAdd(
                { uid: uidsToMarkAsSeen }, 
                ['\\Seen']
            );
            console.log(
                `🏁 Marked UIDs [${uidsToMarkAsSeen.join(', ')}] as SEEN.`
            );
        }

    } catch (err) {
        console.error('Email Listener Error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
    }
}

// ── RECURSIVE WORKER LOOP ──────────────────────────────────
async function runLoop() {
    await processNewEmails();
    setTimeout(runLoop, 30 * 1000);
}

// ── INITIALIZATION INITIAL PATHWAYS ────────────────────────
export async function startEmailListener() {
    if (emailListenerStarted) return;
    emailListenerStarted = true;

    console.log('📧 Email listener service initialized...');

    const client = createClient();
    try {
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        lastUID = mailbox.uidNext - 1;
        console.log(`📧 Syncing from baseline UID pointer: ${lastUID}`);
    } catch (err) {
        console.error('Email initialization error:', err.message);
    } finally {
        try {
            if (client.usable) await client.logout();
        } catch (_) {}
    }

    runLoop();
}
