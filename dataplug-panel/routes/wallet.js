const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { creditReferralIfQualifying } = require('../services/referral');

const router = express.Router();

const PAYSTACK_BASE = 'https://api.paystack.co';
const paystackHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// Site-wide minimum deposit. Also happens to match the referral program's qualifying
// deposit threshold (see services/referral.js) — any successful funding at all qualifies.
const MIN_FUNDING_NAIRA = Number(process.env.MIN_FUNDING_NAIRA || 1000);

// Hard ceiling on any single funding credit, in kobo. No legitimate top-up on this
// panel should ever be near this — it exists purely so a bug (bad unit conversion,
// a corrupted/duplicated amount, anything) can't silently land a huge number in
// someone's balance. Override with MAX_FUNDING_NAIRA in .env if a real business
// reason needs a higher ceiling.
const MAX_FUNDING_KOBO = Math.round(Number(process.env.MAX_FUNDING_NAIRA || 2000000) * 100);

// GET /api/wallet — current balance
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT balance, currency FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Wallet fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch wallet.' });
  }
});

// GET /api/wallet/transactions — ledger history
router.get('/transactions', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const result = await pool.query(
      `SELECT id, type, amount, balance_before, balance_after, reference, status, created_at
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Transactions fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch transactions.' });
  }
});

// POST /api/wallet/fund — initialize a Paystack transaction
// Body: { amount } — amount in Naira (we convert to kobo internally)
router.post('/fund', requireAuth, async (req, res) => {
  const { amount } = req.body;
  const nairaAmount = Number(amount);

  if (!nairaAmount || nairaAmount < MIN_FUNDING_NAIRA) {
    return res.status(400).json({ error: `Minimum funding amount is ₦${MIN_FUNDING_NAIRA}.` });
  }

  const koboAmount = Math.round(nairaAmount * 100);
  const reference = `fund_${req.user.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    // Get user email for Paystack (required field)
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = userResult.rows[0].email;

    // Record a pending transaction BEFORE hitting Paystack, so we never lose track of an attempt.
    const walletResult = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
    const currentBalance = walletResult.rows[0].balance;

    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, status)
       VALUES ($1, 'funding', $2, $3, $3, $4, 'pending')`,
      [req.user.id, koboAmount, currentBalance, reference]
    );

    const paystackRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email,
        amount: koboAmount,
        reference,
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
      },
      { headers: paystackHeaders() }
    );

    res.json({
      authorization_url: paystackRes.data.data.authorization_url,
      reference,
    });
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not initialize payment. Please try again.' });
  }
});

// GET /api/wallet/pending — most recent unresolved funding attempt for this user, if any.
// The frontend uses this on dashboard load instead of relying on sessionStorage or a
// Paystack redirect param — both of which can be lost if the tab/app gets killed and
// reloaded (low memory, OS tab eviction) before the user makes it back to
// payment-callback.html. This lets us re-check a stuck payment no matter how the user
// returns to the app.
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT reference, amount, created_at FROM transactions
       WHERE user_id = $1 AND type = 'funding' AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json({ pending: result.rows[0] || null });
  } catch (err) {
    console.error('Pending fetch error:', err.message);
    res.status(500).json({ error: 'Could not check pending payments.' });
  }
});

// GET /api/wallet/verify/:reference — manual verify (used by the frontend after redirect back)
// The webhook below is the authoritative source of truth; this just gives the user immediate feedback.
router.get('/verify/:reference', requireAuth, async (req, res) => {
  const { reference } = req.params;

  try {
    const txResult = await pool.query(
      'SELECT * FROM transactions WHERE reference = $1 AND user_id = $2',
      [reference, req.user.id]
    );
    const tx = txResult.rows[0];
    if (!tx) return res.status(404).json({ error: 'Transaction not found.' });

    if (tx.status === 'success') {
      return res.json({ status: 'success', message: 'Payment already confirmed.' });
    }

    const verifyRes = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
      headers: paystackHeaders(),
    });

    if (verifyRes.data.data.status === 'success') {
      await creditWalletForFunding(reference);
      return res.json({ status: 'success', message: 'Payment confirmed and wallet credited.' });
    }

    res.json({ status: verifyRes.data.data.status, message: 'Payment not yet successful.' });
  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not verify payment.' });
  }
});

// POST /api/wallet/webhook — Paystack server-to-server webhook.
// This is the SOURCE OF TRUTH for crediting wallets — never trust the client-side redirect alone,
// since a user can close the tab before the redirect fires, or fake a client-side "success".
// Mounted with express.raw() in server.js so we can verify the signature against the raw body.
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body) // raw Buffer
    .digest('hex');

  if (signature !== expectedSignature) {
    console.warn('Paystack webhook signature mismatch — rejecting.');
    return res.sendStatus(401);
  }

  const event = JSON.parse(req.body.toString('utf8'));

  if (event.event === 'charge.success') {
    try {
      await creditWalletForFunding(event.data.reference);
    } catch (err) {
      console.error('Webhook credit error:', err.message);
      // Still return 200 so Paystack doesn't hammer us with retries for a permanent failure;
      // the /verify route and manual reconciliation can catch anything that slips through.
    }
  }

  res.sendStatus(200);
});

// Shared logic: credit a wallet for a given funding reference, idempotently.
async function creditWalletForFunding(reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      'SELECT * FROM transactions WHERE reference = $1 FOR UPDATE',
      [reference]
    );
    const tx = txResult.rows[0];

    if (!tx) throw new Error(`No transaction found for reference ${reference}`);
    if (tx.status === 'success') {
      // Already credited — idempotent no-op. Prevents double-crediting if webhook fires twice
      // or both the webhook and manual /verify race each other.
      await client.query('ROLLBACK');
      return;
    }

    // Refuse to silently apply an abnormally large credit — flag it for manual review
    // instead. Whatever caused it (bad data, a bug, anything), a wallet balance should
    // never move by this much without a human confirming it first.
    // BIGINT columns come back from `pg` as strings (to avoid precision loss) — compare
    // as BigInt, never as raw strings or with implicit Number coercion.
    if (BigInt(tx.amount) > BigInt(MAX_FUNDING_KOBO)) {
      await client.query(
        `UPDATE transactions SET status = 'flagged' WHERE reference = $1`,
        [reference]
      );
      await client.query('COMMIT');
      console.error(
        `FLAGGED: funding transaction ${reference} for user ${tx.user_id} has amount ${tx.amount} kobo ` +
        `(exceeds MAX_FUNDING_KOBO=${MAX_FUNDING_KOBO}). Not credited — needs manual review.`
      );
      return;
    }

    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [tx.user_id]
    );
    // BUG FIX: balance and amount are BIGINT columns — `pg` returns them as JS strings,
    // so `currentBalance + tx.amount` was STRING CONCATENATION, not addition
    // (e.g. "9080" + "10000" -> "908010000" instead of 19080). Must convert to BigInt
    // before doing arithmetic, then back to a string for the query parameter.
    const currentBalance = BigInt(walletResult.rows[0].balance);
    const newBalance = currentBalance + BigInt(tx.amount);

    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
      newBalance.toString(),
      tx.user_id,
    ]);

    await client.query(
      `UPDATE transactions SET status = 'success', balance_after = $1 WHERE reference = $2`,
      [newBalance.toString(), reference]
    );

    await client.query('COMMIT');

    // Referral bonus check — deliberately AFTER commit, in its own transaction (see
    // services/referral.js). This funding is already safely credited either way; a
    // failure in the referral step must never roll back or block the deposit itself.
    creditReferralIfQualifying(tx.user_id, BigInt(tx.amount)).catch((err) =>
      console.error(`Referral check failed for user ${tx.user_id}:`, err.message)
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/wallet/referrals — the logged-in user's own referral history (as the referrer)
router.get('/referrals', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.status, r.reward_amount, r.created_at, r.rewarded_at, u.username AS referred_username
       FROM referrals r JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = $1 ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    const totalEarned = result.rows
      .filter((r) => r.status === 'rewarded')
      .reduce((sum, r) => sum + Number(r.reward_amount), 0);
    res.json({ referrals: result.rows, totalEarned });
  } catch (err) {
    console.error('Referrals fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch referrals.' });
  }
});

module.exports = router;
module.exports.creditWalletForFunding = creditWalletForFunding;
