require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('✅ Schema applied (tables created where missing, networks seeded).');

    // Seed the VTPass provider from env vars if no providers exist yet — lets a fresh
    // deploy work immediately without a manual admin-panel step, IF those env vars are
    // set. Safe to skip: you can always add the provider from the admin panel instead.
    const existing = await pool.query('SELECT COUNT(*) FROM providers');
    if (Number(existing.rows[0].count) === 0 && process.env.VTPASS_API_KEY && process.env.VTPASS_SECRET_KEY && process.env.VTPASS_PUBLIC_KEY) {
      await pool.query(
        `INSERT INTO providers (name, slug, api_url, api_key, secret_key, public_key, api_type, markup_multiplier)
         VALUES ($1, $2, $3, $4, $5, $6, 'vtpass', $7)`,
        [
          'VTPass',
          'vtpass',
          process.env.VTPASS_API_URL || 'https://vtpass.com/api',
          process.env.VTPASS_API_KEY,
          process.env.VTPASS_SECRET_KEY,
          process.env.VTPASS_PUBLIC_KEY,
          Number(process.env.MARKUP_MULTIPLIER) || 1.15,
        ]
      );
      console.log('✅ Seeded VTPass provider from environment variables.');
    }

    console.log('✅ Migration complete.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
