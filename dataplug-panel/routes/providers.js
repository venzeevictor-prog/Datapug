const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAction } = require('../services/audit');
const { getProviderClient } = require('../services/providerRegistry');

const router = express.Router();

const VALID_API_TYPES = ['vtpass']; // extend this list if a second data reseller is ever added

// GET /api/providers — list all configured upstream providers (admin)
router.get('/', requireAuth, requirePermission('services.manage'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, api_url, api_type, markup_multiplier, is_active, created_at,
              (SELECT COUNT(*) FROM data_plans WHERE provider_id = providers.id) AS plan_count
       FROM providers ORDER BY created_at ASC`
    );
    // Never send api_key/secret_key/public_key to the client — write-only, masked on read.
    res.json(result.rows);
  } catch (err) {
    console.error('Providers list error:', err.message);
    res.status(500).json({ error: 'Could not fetch providers.' });
  }
});

// POST /api/providers — add a new upstream data API to resell
router.post('/', requireAuth, requirePermission('services.manage'), async (req, res) => {
  const { name, slug, api_url, api_key, secret_key, public_key, api_type, markup_multiplier } = req.body;

  if (!name || !slug || !api_url || !api_key) {
    return res.status(400).json({ error: 'name, slug, api_url, and api_key are required.' });
  }
  if (!/^[a-z0-9-]{3,50}$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be lowercase letters, numbers, and hyphens only.' });
  }
  const type = api_type || 'vtpass';
  if (!VALID_API_TYPES.includes(type)) {
    return res.status(400).json({ error: `api_type must be one of: ${VALID_API_TYPES.join(', ')}` });
  }
  if (type === 'vtpass' && (!secret_key || !public_key)) {
    return res.status(400).json({ error: 'VTPass requires secret_key and public_key in addition to api_key.' });
  }
  try {
    new URL(api_url);
  } catch {
    return res.status(400).json({ error: 'api_url must be a valid URL.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO providers (name, slug, api_url, api_key, secret_key, public_key, api_type, markup_multiplier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, slug, api_url, api_type, markup_multiplier, is_active, created_at`,
      [name, slug, api_url, api_key, secret_key || null, public_key || null, type, Number(markup_multiplier) || 1.15]
    );

    await logAction(req.user.id, 'provider.create', 'provider', result.rows[0].id, { name, slug });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A provider with that slug already exists.' });
    }
    console.error('Provider create error:', err.message);
    res.status(500).json({ error: 'Could not create provider.' });
  }
});

// PATCH /api/providers/:id — update a provider's config (rotate keys, change markup, etc.)
router.patch('/:id', requireAuth, requirePermission('services.manage'), async (req, res) => {
  const { name, api_url, api_key, secret_key, public_key, markup_multiplier, is_active } = req.body;
  const updates = [];
  const values = [];
  let i = 1;

  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
  if (api_url !== undefined) {
    try { new URL(api_url); } catch { return res.status(400).json({ error: 'api_url must be a valid URL.' }); }
    updates.push(`api_url = $${i++}`); values.push(api_url);
  }
  if (api_key !== undefined && api_key.trim() !== '') { updates.push(`api_key = $${i++}`); values.push(api_key); }
  if (secret_key !== undefined && secret_key.trim() !== '') { updates.push(`secret_key = $${i++}`); values.push(secret_key); }
  if (public_key !== undefined && public_key.trim() !== '') { updates.push(`public_key = $${i++}`); values.push(public_key); }
  if (markup_multiplier !== undefined) { updates.push(`markup_multiplier = $${i++}`); values.push(Number(markup_multiplier)); }
  if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(Boolean(is_active)); }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields provided to update.' });
  }
  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE providers SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i}
       RETURNING id, name, slug, api_url, api_type, markup_multiplier, is_active`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Provider not found.' });

    await logAction(req.user.id, 'provider.update', 'provider', req.params.id, {
      name, api_url, markup_multiplier, is_active,
      keys_rotated: Boolean(api_key || secret_key || public_key),
    });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Provider update error:', err.message);
    res.status(500).json({ error: 'Could not update provider.' });
  }
});

// GET /api/providers/:id/balance — check remaining VTPass wallet balance
router.get('/:id/balance', requireAuth, requirePermission('provider.view_balance'), async (req, res) => {
  try {
    const { client } = await getProviderClient(req.params.id);
    const data = await client.getProviderBalance();
    res.json(data);
  } catch (err) {
    console.error('Provider balance error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not fetch provider balance.' });
  }
});

module.exports = router;
