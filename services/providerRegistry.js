const pool = require('../db/pool');
const { createProviderClient } = require('./provider');

// Looks up a provider by ID and returns a ready-to-use API client for it.
// No caching on purpose — provider credentials can change (admin rotates an API key)
// and every order/status call is infrequent enough that a fresh DB read is cheap
// compared to the risk of an admin updating a key and stale clients keep using the old one.
async function getProviderClient(providerId) {
  const result = await pool.query('SELECT * FROM providers WHERE id = $1 AND is_active = true', [providerId]);
  const providerRow = result.rows[0];
  if (!providerRow) {
    throw new Error(`Provider ${providerId} not found or inactive.`);
  }
  return { client: createProviderClient(providerRow), providerRow };
}

module.exports = { getProviderClient };
