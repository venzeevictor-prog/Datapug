const axios = require('axios');
const pool = require('../db/pool');
const { creditWalletForFunding } = require('../routes/wallet');

const PAYSTACK_BASE = 'https://api.paystack.co';

// Reconciles funding transactions that never got resolved by the webhook or the
// frontend's own verify calls — e.g. the user's tab/app got killed for memory while
// they were on Paystack's page, they hit "back" instead of landing on
// payment-callback.html, or Paystack's webhook simply never arrived (delivery isn't
// guaranteed). This is independent of any client action: it runs on a timer and asks
// Paystack directly, so a payment gets credited even if the user never reopens the app.
//
// - Waits 5 min before checking a reference, so we don't race an in-progress checkout.
// - Gives up (marks 'failed') after 24h so genuinely abandoned attempts don't get
//   retried forever or misrepresent the user's transaction history as still pending.
async function reconcilePendingFunding() {
  let rows;
  try {
    const result = await pool.query(
      `SELECT reference, created_at FROM transactions
       WHERE type = 'funding' AND status = 'pending'
         AND created_at < now() - interval '5 minutes'
       ORDER BY created_at ASC LIMIT 50`
    );
    rows = result.rows;
  } catch (err) {
    console.error('Reconcile: could not load pending transactions:', err.message);
    return;
  }

  for (const row of rows) {
    try {
      const verifyRes = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${row.reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      });
      const paystackStatus = verifyRes.data.data.status;

      if (paystackStatus === 'success') {
        await creditWalletForFunding(row.reference);
        console.log(`Reconcile: credited stuck funding ${row.reference}`);
      } else if (
        (paystackStatus === 'failed' || paystackStatus === 'abandoned') &&
        Date.now() - new Date(row.created_at).getTime() > 24 * 60 * 60 * 1000
      ) {
        await pool.query(`UPDATE transactions SET status = 'failed' WHERE reference = $1`, [row.reference]);
        console.log(`Reconcile: gave up on ${row.reference} after 24h (${paystackStatus})`);
      }
      // Otherwise still genuinely pending on Paystack's side — leave it for the next sweep.
    } catch (err) {
      console.error(`Reconcile: verify failed for ${row.reference}:`, err.response?.data || err.message);
    }
  }
}

function startReconciliationSweep() {
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    reconcilePendingFunding().catch((err) => console.error('Reconcile sweep error:', err.message));
  }, INTERVAL_MS);
  // Also run shortly after boot rather than waiting a full interval the first time.
  setTimeout(() => {
    reconcilePendingFunding().catch((err) => console.error('Reconcile sweep error:', err.message));
  }, 30 * 1000);
}

module.exports = { startReconciliationSweep, reconcilePendingFunding };
