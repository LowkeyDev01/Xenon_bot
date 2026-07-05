import { onlineDBClient as pool } from './db.js';
import { startEmailListener } from './email_listener.js';
import express from 'express';
import cors from 'cors';

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err?.message);
});

// ── EXPRESS ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── KOBO LOGIC ─────────────────────────────────────────────
async function assignUniqueAmount(baseAmount = 1000) {
    const { rows } = await pool.query(
        `SELECT amount FROM pending_payments 
         WHERE status = 'pending'
         AND created_at > NOW() - INTERVAL '15 minutes'`
    );

    const usedKobos = new Set(rows.map(r => Math.round((r.amount % 1) * 100)));

    for (let kobo = 1; kobo <= 99; kobo++) {
        if (!usedKobos.has(kobo)) {
            return baseAmount + (kobo / 100);
        }
    }

    throw new Error('All kobo slots taken.');
}

async function createPendingPayment(phone) {
    const amount = await assignUniqueAmount();
    await pool.query(
        `INSERT INTO pending_payments (wa_id, amount) VALUES ($1, $2)`,
        [phone, amount]
    );
    return amount;
}

// ── EXPIRY JOB ─────────────────────────────────────────────
function startExpiryJob() {
    setInterval(async () => {
        try {
            await pool.query(
                `UPDATE pending_payments 
                 SET status = 'expired'
                 WHERE status = 'pending'
                 AND created_at < NOW() - INTERVAL '15 minutes'`
            );
        } catch (err) {
            console.error('Expiry Job Error:', err.message);
        }
    }, 60 * 1000);
}

// ── API ROUTES ─────────────────────────────────────────────

// GET /dashboard?phone=2348137811382
app.get('/dashboard', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        const { rows: pending } = await pool.query(
            `SELECT * FROM pending_payments 
             WHERE wa_id = $1 AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [phone]
        );

        const { rows: codes } = await pool.query(
            `SELECT code_string, bought_at FROM codes
             WHERE wa_id = $1 AND is_bought = true
             ORDER BY bought_at DESC`,
            [phone]
        );

        res.json({
            pending: pending[0] || null,
            codes
        });
    } catch (err) {
        console.error('Dashboard Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /buy
app.post('/buy', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        const { rows: existing } = await pool.query(
            `SELECT * FROM pending_payments 
             WHERE wa_id = $1 AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [phone]
        );

        if (existing.length > 0) {
            return res.json({ success: false, message: 'You already have a pending order' });
        }

        const amount = await createPendingPayment(phone);
        res.json({ success: true, amount });
    } catch (err) {
        console.error('Buy Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /cancel
app.post('/cancel', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        await pool.query(
            `UPDATE pending_payments SET status = 'cancelled'
             WHERE wa_id = $1 AND status = 'pending'`,
            [phone]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Cancel Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /check-payment?phone=2348137811382
app.get('/check-payment', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    try {
        const { rows } = await pool.query(
            `SELECT * FROM pending_payments 
             WHERE wa_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [phone]
        );

        if (rows.length === 0) return res.json({ status: 'none' });

        const order = rows[0];

        if (order.status === 'paid') {
            const updateResult = await pool.query(
                `UPDATE codes SET is_bought = true, bought_at = NOW(), wa_id = $1 
                 WHERE code_string = (
                     SELECT code_string FROM codes 
                     WHERE is_bought = false AND account_type = 'USER' 
                     FOR UPDATE SKIP LOCKED LIMIT 1
                 ) RETURNING code_string`,
                [phone]
            );

            const code = updateResult.rows[0]?.code_string;
            return res.json({ status: 'paid', code });
        }

        res.json({ status: order.status });
    } catch (err) {
        console.error('Check Payment Error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/', (req, res) => res.send('Xenon is alive!'));

app.listen(process.env.PORT || 5000, () => {
    console.log(`🌐 Server running on port ${process.env.PORT || 5000}`);
});

startExpiryJob();
startEmailListener();
