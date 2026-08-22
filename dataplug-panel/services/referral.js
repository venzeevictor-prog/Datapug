const pool = require('../db/pool');

// ₦3,500 per successful referral. A referred user must fund their wallet with at least
// MIN_QUALIFYING_DEPOSIT_NAIRA before their referrer gets paid — this is the SAME number
// as the site-wide minimum deposit (see MIN_FUNDING_NAIRA in routes/wallet.js), so in
// practice any successful funding at all qualifies. Kept as its own constant here rather
// than importing wallet.js's, since "what counts as a qualifying referral deposit" and
// "what's the minimum funding allowed at all" are different concerns that just happen to
// currently share a number — if you ever raise the referral bar above the funding floor,
// change this one without touching wallet.js.
const REFERRAL_BONUS_NAIRA = 3500;
const REFERRAL_BONUS_KOBO = REFERRAL_BONUS_NAIRA * 100;
const MIN_QUALIFYING_DEPOSIT_KOBO = 1000 * 100;

// Call this after ANY successful funding transaction completes (webhook, manual verify,
// or the reconciliation sweep — see routes/wallet.js and services/reconcile.js). Safe to
// call on every deposit, every time: the UPDATE only matches a referrals row that's still
// 'pending', so a user's second/third/etc. deposit — or two funding paths racing on the
// same deposit — can never pay the referrer twice.
async function creditReferralIfQualifying(referredUserId, depositAmountKobo) {
  if (depositAmountKobo < MIN_QUALIFYING_DEPOSIT_KOBO) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row lock + status check in one statement — this IS the idempotency guarantee.
    const referralResult = await client.query(
      `UPDATE referrals SET status = 'rewarded', rewarded_at = now()
       WHERE referred_id = $1 AND status = 'pending'
       RETURNING referrer_id, reward_amount`,
      [referredUserId]
    );
    const referral = referralResult.rows[0];
    if (!referral) {
      // No pending referral for this user (never referred, or already rewarded) — normal, not an error.
      await client.query('ROLLBACK');
      return;
    }

    const walletResult = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [referral.referrer_id]);
    if (!walletResult.rows[0]) {
      // Referrer's wallet is somehow gone — extremely unlikely, but don't silently lose
      // the reward: roll back so the referrals row stays 'pending' and this retries later.
      await client.query('ROLLBACK');
      console.error(`Referral credit: referrer ${referral.referrer_id} has no wallet — leaving referral pending for retry.`);
      return;
    }

    const currentBalance = BigInt(walletResult.rows[0].balance);
    const rewardKobo = BigInt(referral.reward_amount);
    const newBalance = currentBalance + rewardKobo;

    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [newBalance.toString(), referral.referrer_id]);

    const reference = `refbonus_${referredUserId}_${Date.now()}`;
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, status, metadata)
       VALUES ($1, 'referral_bonus', $2, $3, $4, $5, 'success', $6)`,
      [referral.referrer_id, rewardKobo.toString(), currentBalance.toString(), newBalance.toString(), reference, JSON.stringify({ referred_user_id: referredUserId })]
    );

    await client.query('COMMIT');
    console.log(`Referral bonus paid: ₦${REFERRAL_BONUS_NAIRA} to user ${referral.referrer_id} for referring user ${referredUserId}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Referral credit failed for referred user ${referredUserId}:`, err.message);
  } finally {
    client.release();
  }
}

module.exports = { creditReferralIfQualifying, REFERRAL_BONUS_NAIRA, REFERRAL_BONUS_KOBO, MIN_QUALIFYING_DEPOSIT_KOBO };
