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

// ── EXPRESS & CORS CONFIGURATION ───────────────────────────
const app = express();

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors()); 

app.use(express.json());

// ── TIMEZONE-IMMUNE KOBO LOGIC ─────────────────────────────
async function assignUniqueAmount(baseAmount = 1000) {
    // 1. Get raw numeric Unix timestamp from JavaScript (e.g., 1719874500000)
    const fifteenMinutesAgoEpoch = Date.now() - 15 * 60 * 1000;

    // 2. Convert database created_at column to epoch milliseconds for direct numeric comparison
    const { rows } = await pool.query(
        `SELECT amount FROM pending_payments 
         WHERE status = 'pending'
         AND EXTRACT(EPOCH FROM created_at) * 1000 > $1`,
        [fifteenMinutesAgoEpoch]
    );

    // 3. Robust conversion handling PostgreSQL numeric strings safely
    const usedKobos = new Set(
        rows.map(r => {
            const parsedAmount = typeof r.amount === 'string' ? parseFloat(r.amount) : r.amount;
            const totalKobo = Math.round(parsedAmount * 100);
            return totalKobo % 100;
        })
    );

    console.log(`📊 Current Kobos in use (last 15 mins):`, Array.from(usedKobos));

    // 4. Fallback sequence scanning for the first empty fraction slot (.01 to .99)
    for (let kobo = 1; kobo <= 99; kobo++) {
        if (!usedKobos.has(kobo)) {
            const finalAmount = parseFloat((baseAmount + (kobo / 100)).toFixed(2));
            console.log(`✅ Unique amount allocated: ₦${finalAmount}`);
            return finalAmount;
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
            const fifteenMinutesAgoEpoch = Date.now() - 15 * 60 * 1000;
            await pool.query(
                `UPDATE pending_payments 
                 SET status = 'expired'
                 WHERE status = 'pending'
                 AND EXTRACT(EPOCH FROM created_at) * 1000 < $1`,
                [fifteenMinutesAgoEpoch]
            );
        } catch (err) {
            console.error('Expiry Job Error:', err.message);
        }
    }, 60 * 1000);
}

// ── API ROUTES ─────────────────────────────────────────────

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
        
