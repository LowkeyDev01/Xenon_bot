import { onlineDBClient as pool } from './db.js';
import { startEmailListener } from './email_listener.js';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err?.message);
});

const app = express();
app.use(cors());
app.use(express.json());

// ── AUTH MIDDLEWARE ────────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ── KOBO LOGIC ─────────────────────────────────────────────
async function assignUniqueAmount(baseAmount = 1000) {
    // Block ALL statuses within 15 mins — prevents reuse after cancel
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

// ── AUTH ROUTES ────────────────────────────────────────────

// POST /register
app.post('/register', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (phone, password_hash) VALUES ($1, $2)`,
            [phone, hash]
        );
        const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Phone number already registered' });
        }
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /login
app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    try {
        const { rows } = await pool.query(`SELECT * FROM users WHERE phone = $1`, [phone]);
        if (rows.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, rows[0].password_hash);
        if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /verify-token
app.post('/verify-token', authMiddleware, (req, res) => {
    res.json({ valid: true, phone: req.user.phone });
});

// ── PROTECTED ROUTES ───────────────────────────────────────

// GET /dashboard
app.get('/dashboard', authMiddleware, async (req, res) => {
    const phone = req.user.phone;

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
app.post('/buy', authMiddleware, async (req, res) => {
    const phone = req.user.phone;

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
app.post('/cancel', authMiddleware, async (req, res) => {
    const phone = req.user.phone;

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

// GET /check-payment
app.get('/check-payment', authMiddleware, async (req, res) => {
    const phone = req.user.phone;

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
            // Check if code already distributed for this order
            const { rows: existing } = await pool.query(
                `SELECT code_string FROM codes WHERE wa_id = $1 AND bought_at >= $2`,
                [phone, order.date_paid || order.created_at]
            );

            if (existing.length > 0) {
                return res.json({ status: 'paid', code: existing[0].code_string });
            }

            const updateResult = await pool.query(
                `UPDATE codes SET is_bought = true, bought_at = NOW(), wa_id = $1 
                 WHERE code_string = (
                     SELECT code_string FROM codes 
                     WHERE is_bought = false AND account_type = 'USER' 
                     FOR UPDATE SKIP LOCKED LIMIT 1
                 ) RETURNING code_string`,
                [phone]
            );

            if (!updateResult.rows[0]) {
                return res.json({ status: 'paid', code: null, message: 'No codes available' });
            }

            return res.json({ status: 'paid', code: updateResult.rows[0].code_string });
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
