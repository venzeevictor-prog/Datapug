const { Pool } = require('pg');

// Neon, Supabase, and Render's managed Postgres all require SSL — and reject plain
// connections outright — so this checks the actual host rather than NODE_ENV. A local
// Postgres on localhost/127.0.0.1 (typical for development) usually isn't configured for
// SSL at all, so we skip it there; anything else gets SSL with rejectUnauthorized: false
// (these providers use certs that Node's default trust store doesn't always chain to,
// which is normal for managed Postgres — the connection itself is still encrypted).
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PG client', err);
});

module.exports = pool;
