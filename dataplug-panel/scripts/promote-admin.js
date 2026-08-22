// One-time helper: promotes a user to super_admin using the same DATABASE_URL
// your app already uses. Run from the project root:
//
//   node scripts/promote-admin.js your_username
//
// (uses the username you signed up with, not your email)

require('dotenv').config();
const pool = require('../db/pool');

async function promote() {
  const username = process.argv[2];

  if (!username) {
    console.error('Usage: node scripts/promote-admin.js <username>');
    process.exit(1);
  }

  try {
    const result = await pool.query(
      `UPDATE users SET role = 'super_admin', updated_at = now()
       WHERE username = $1 OR email = $1
       RETURNING id, username, email, role`,
      [username]
    );

    if (result.rows.length === 0) {
      console.error(`No user found with username or email "${username}". Sign up first, then run this again.`);
      process.exit(1);
    }

    console.log('✅ Promoted:', result.rows[0]);
    console.log('Log out and log back in on the site for the change to take effect (your login token has the old role baked in).');
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

promote();
