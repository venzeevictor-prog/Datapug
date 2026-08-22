// Recomputes a user's wallet balance from their transaction ledger, from scratch,
// using correct BigInt arithmetic — ignoring whatever bad balance_before/balance_after
// values got written by the pre-fix string-concatenation bug. Safe by default: prints a
// full diff and does NOT write anything unless you pass --apply.
//
// Usage:
//   node scripts/repair-wallet-balance.js <user_id>            # dry run — just shows the diff
//   node scripts/repair-wallet-balance.js <user_id> --apply    # actually fixes it
//
// What "fixing it" means:
//   - Walks every 'success' transaction for the user in chronological order
//   - Recomputes balance_before/balance_after for each row correctly
//   - Updates wallets.balance to the final correct total
//   - Runs in a single DB transaction — either it all applies, or none of it does

const pool = require('../db/pool');

async function main() {
  const userId = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!userId) {
    console.error('Usage: node scripts/repair-wallet-balance.js <user_id> [--apply]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txResult = await client.query(
      `SELECT id, type, amount, balance_before, balance_after, reference, status, metadata, created_at
       FROM transactions
       WHERE user_id = $1 AND status = 'success'
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
      [userId]
    );

    const walletResult = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!walletResult.rows[0]) {
      console.error(`No wallet found for user_id ${userId}.`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    const currentCachedBalance = BigInt(walletResult.rows[0].balance);

    let running = 0n;
    const fixes = [];

    for (const tx of txResult.rows) {
      const amount = BigInt(tx.amount);
      let direction;
      if (tx.type === 'funding' || tx.type === 'refund' || tx.type === 'referral_bonus') {
        direction = 1n;
      } else if (tx.type === 'order_debit') {
        direction = -1n;
      } else if (tx.type === 'adjustment') {
        direction = tx.metadata?.direction === 'debit' ? -1n : 1n;
      } else {
        console.warn(`Unknown transaction type "${tx.type}" on tx ${tx.id} — skipping in recompute.`);
        continue;
      }

      const correctBefore = running;
      running += direction * amount;
      const correctAfter = running;

      const storedBefore = BigInt(tx.balance_before);
      const storedAfter = BigInt(tx.balance_after);

      if (storedBefore !== correctBefore || storedAfter !== correctAfter) {
        fixes.push({
          id: tx.id,
          reference: tx.reference,
          created_at: tx.created_at,
          storedBefore: storedBefore.toString(),
          correctBefore: correctBefore.toString(),
          storedAfter: storedAfter.toString(),
          correctAfter: correctAfter.toString(),
        });
      }
    }

    console.log(`\nUser ${userId} — ${txResult.rows.length} successful transactions checked.`);
    console.log(`Currently cached wallets.balance: ${currentCachedBalance.toString()} kobo`);
    console.log(`Correct balance from ledger:      ${running.toString()} kobo\n`);

    if (fixes.length === 0 && currentCachedBalance === running) {
      console.log('Nothing to fix — ledger and cached balance already agree.');
      await client.query('ROLLBACK');
      return;
    }

    console.log(`${fixes.length} transaction row(s) have incorrect balance_before/balance_after:\n`);
    for (const f of fixes) {
      console.log(
        `  tx ${f.id} (${f.reference}, ${f.created_at.toISOString()})\n` +
        `    balance_before: ${f.storedBefore} -> ${f.correctBefore}\n` +
        `    balance_after:  ${f.storedAfter} -> ${f.correctAfter}`
      );
    }

    if (!apply) {
      console.log('\nDry run only — nothing written. Re-run with --apply to fix.');
      await client.query('ROLLBACK');
      return;
    }

    // Re-walk and actually write the corrected values.
    running = 0n;
    for (const tx of txResult.rows) {
      const amount = BigInt(tx.amount);
      let direction;
      if (tx.type === 'funding' || tx.type === 'refund' || tx.type === 'referral_bonus') direction = 1n;
      else if (tx.type === 'order_debit') direction = -1n;
      else if (tx.type === 'adjustment') direction = tx.metadata?.direction === 'debit' ? -1n : 1n;
      else continue;

      const before = running;
      running += direction * amount;
      const after = running;

      await client.query(
        'UPDATE transactions SET balance_before = $1, balance_after = $2 WHERE id = $3',
        [before.toString(), after.toString(), tx.id]
      );
    }

    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
      running.toString(),
      userId,
    ]);

    await client.query('COMMIT');
    console.log(`\nApplied. wallets.balance for user ${userId} is now ${running.toString()} kobo.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Repair failed, nothing was written:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
