const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../middleware/permissions');
const { logAction } = require('../services/audit');
const { getProviderClient } = require('../services/providerRegistry');
const { buildRequestId, classifyDuration, extractDataSize } = require('../services/provider');

const router = express.Router();

// GET /api/plans — public catalog: network -> duration -> plans. Only active plans show;
// see POST /sync below for why a fresh sync only activates 'weekly' plans by default.
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.id, dp.data_size, dp.duration, dp.price, dp.raw_name,
              n.name AS network_name, n.slug AS network_slug
       FROM data_plans dp JOIN networks n ON n.id = dp.network_id
       WHERE dp.is_active = true AND n.is_active = true
       ORDER BY n.name, dp.duration, dp.price`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Plans fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch plans.' });
  }
});

// GET /api/plans/preview — public, NO auth: a capped preview of active plans, for the
// marketing homepage's pricing table. Deliberately doesn't expose the full catalog or
// require login — just enough to show real prices before someone commits to signing up.
router.get('/preview', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.data_size, dp.duration, dp.price, dp.raw_name, n.name AS network_name
       FROM data_plans dp JOIN networks n ON n.id = dp.network_id
       WHERE dp.is_active = true AND n.is_active = true
       ORDER BY n.name, dp.price ASC`
    );
    // Cap to the cheapest 10 per network here rather than in SQL — four networks, small
    // result set either way, and this keeps the query simple to read.
    const byNetwork = {};
    for (const row of result.rows) {
      (byNetwork[row.network_name] ||= []).push(row);
    }
    for (const name of Object.keys(byNetwork)) {
      byNetwork[name] = byNetwork[name].slice(0, 10);
    }
    res.json(byNetwork);
  } catch (err) {
    console.error('Plans preview fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch plans.' });
  }
});

// GET /api/plans/all — admin view, all plans regardless of active status, with margins
router.get('/all', requireAuth, requirePermission('services.manage'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dp.id, dp.raw_name, dp.data_size, dp.duration, dp.price, dp.provider_price,
              dp.custom_price, dp.is_active, dp.updated_at,
              n.id AS network_id, n.name AS network_name,
              p.id AS provider_id, p.name AS provider_name,
              CASE WHEN dp.price > 0 THEN ROUND(((dp.price - dp.provider_price) / dp.price * 100)::numeric, 1) ELSE 0 END AS margin_percent
       FROM data_plans dp
       JOIN networks n ON n.id = dp.network_id
       JOIN providers p ON p.id = dp.provider_id
       ORDER BY n.name, dp.duration, dp.price`
    );
    res.json(result.rows.map((row) => {
      if (hasPermission(req.user.role, 'costs.view_exact')) return row;
      const { provider_price, ...visible } = row;
      return visible;
    }));
  } catch (err) {
    console.error('Admin plans fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch plans.' });
  }
});

// POST /api/plans/sync/:providerId — pull the latest variation codes for ALL FOUR networks
// from VTPass and upsert. Full catalog, all durations active by default. Pricing = (provider
// cost x markup) with a further 50% cut applied — see DISCOUNT_MULTIPLIER below for the
// margin-safety flag on that math. Plans priced below ₦500 after the cut are synced but
// left hidden rather than skipped, so they're recoverable later without a re-sync.
// Manual price overrides (custom_price) make a row immune to future auto-adjustment of
// both price and visibility — treated as "an admin already reviewed this one."
router.post('/sync/:providerId', requireAuth, requirePermission('services.manage'), async (req, res) => {
  const { client: providerClient, providerRow } = await getProviderClient(req.params.providerId).catch((err) => {
    throw Object.assign(new Error(err.message), { lookupFailed: true });
  });
  if (providerRow.api_type !== 'vtpass') {
    return res.status(400).json({ error: `Provider "${providerRow.name}" is not a VTPass-type provider.` });
  }

  const networksResult = await pool.query('SELECT * FROM networks WHERE is_active = true');
  const networks = networksResult.rows;
  const markup = Number(providerRow.markup_multiplier);

  // Pricing rule, as instructed: take the normal marked-up price (provider cost x markup)
  // and cut it by 50% — displayed as a flat price, no "50% off" badge anywhere.
  // FLAG: with the default 15% markup (markup_multiplier=1.15), this computes to
  // provider_price * 1.15 * 0.5 = provider_price * 0.575 — i.e. ~58% of what VTPass
  // actually charges. That's well below cost, not a discount off your margin. If that's
  // not what you meant, either raise markup_multiplier on the provider (Providers tab)
  // well above 2.0 before this discount would even break even, or tell me to change this rule.
  const DISCOUNT_MULTIPLIER = 0.5; // "minus 50%"
  const MIN_PRICE_NAIRA = 500; // general floor — plans priced below this after discount are synced but hidden, not skipped
  const MIN_PRICE_DAILY_NAIRA = 600; // daily plans specifically use a higher floor

  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalHiddenLowPrice = 0;
  const perNetworkSummary = [];

  for (const network of networks) {
    let response;
    try {
      response = await providerClient.getVariations(network.vtpass_service_id);
    } catch (err) {
      console.error(`Plan sync: fetch failed for ${network.name}:`, err.response?.data || err.message);
      perNetworkSummary.push(`${network.name}: fetch failed`);
      continue;
    }

    const variations = response?.content?.variations;
    if (!Array.isArray(variations)) {
      perNetworkSummary.push(`${network.name}: unexpected response shape`);
      continue;
    }

    let networkUpserted = 0;
    for (const v of variations) {
      const providerPrice = Number(v.variation_amount);
      if (!v.variation_code || !v.name || !Number.isFinite(providerPrice)) {
        totalSkipped++;
        continue;
      }

      const duration = classifyDuration(v.name);
      const dataSize = extractDataSize(v.name);
      const markedUpPrice = providerPrice * markup;
      const price = Math.round(markedUpPrice * DISCOUNT_MULTIPLIER * 100) / 100;
      const meetsFloor = price >= (duration === 'daily' ? MIN_PRICE_DAILY_NAIRA : MIN_PRICE_NAIRA);
      if (!meetsFloor) totalHiddenLowPrice++;

      // Full catalog now — every duration syncs active, not just weekly. A plan below the
      // ₦500 floor still gets stored (so it's there if you ever want to enable it) but
      // starts hidden. Existing rows: is_active is only touched if you haven't manually
      // customized this plan's price — a manual price edit is treated as "admin has
      // reviewed this row," so a re-sync won't silently flip its visibility back.
      const result = await pool.query(
        `INSERT INTO data_plans (network_id, provider_id, provider_variation_code, raw_name, data_size, duration, provider_price, price, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (network_id, provider_variation_code) DO UPDATE SET
           raw_name = EXCLUDED.raw_name,
           data_size = EXCLUDED.data_size,
           provider_price = EXCLUDED.provider_price,
           price = CASE WHEN data_plans.custom_price THEN data_plans.price ELSE EXCLUDED.price END,
           is_active = CASE WHEN data_plans.custom_price THEN data_plans.is_active ELSE EXCLUDED.is_active END,
           updated_at = now()`,
        [network.id, providerRow.id, v.variation_code, v.name, dataSize, duration, providerPrice, price, meetsFloor]
      );
      networkUpserted += result.rowCount;
    }
    totalUpserted += networkUpserted;
    perNetworkSummary.push(`${network.name}: ${networkUpserted} plans`);
  }

  await logAction(req.user.id, 'plans.sync', 'provider', providerRow.id, { totalUpserted, totalSkipped, perNetworkSummary });
  res.json({
    message: `Synced ${totalUpserted} plans across ${networks.length} networks (${perNetworkSummary.join(', ')}). ` +
      `${totalHiddenLowPrice} plan(s) below the price floor (₦${MIN_PRICE_NAIRA} general, ₦${MIN_PRICE_DAILY_NAIRA} daily) were synced but left hidden.`,
  });
});

// PATCH /api/plans/:id — manual price override and/or active toggle (e.g. turning on
// 'monthly' or '2-3months' plans once you're ready to expand past weekly)
router.patch('/:id', requireAuth, requirePermission('services.manage'), async (req, res) => {
  const { price, is_active } = req.body;
  const updates = [];
  const values = [];
  let i = 1;

  if (price !== undefined) {
    const p = Number(price);
    if (!p || p <= 0) return res.status(400).json({ error: 'price must be a positive number.' });
    updates.push(`price = $${i++}`, `custom_price = true`);
    values.push(p.toFixed(2));
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false.' });
    updates.push(`is_active = $${i++}`);
    values.push(is_active);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Provide price and/or is_active to update.' });
  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE data_plans SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    await logAction(req.user.id, 'plan.update', 'data_plan', req.params.id, { price, is_active });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Plan update error:', err.message);
    res.status(500).json({ error: 'Could not update plan.' });
  }
});

// POST /api/plans — buy a plan for a phone number. Unlike the logs-marketplace pattern
// this was adapted from, VTPass purchases are NOT guaranteed synchronous — the initial
// response can be 'pending', requiring a follow-up requery (see services/dataOrderProcessor.js).
// So this always creates the order as 'pending' first, then updates it based on what VTPass
// actually says — never assumes success just because the HTTP call didn't throw.
router.post('/', requireAuth, async (req, res) => {
  const { planId, phoneNumber } = req.body;

  if (!planId) return res.status(400).json({ error: 'planId is required.' });
  if (!phoneNumber || !/^0\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ error: 'phoneNumber must be a valid 11-digit Nigerian number starting with 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const planResult = await client.query(
      `SELECT dp.*, n.vtpass_service_id, p.id AS provider_row_id
       FROM data_plans dp JOIN networks n ON n.id = dp.network_id JOIN providers p ON p.id = dp.provider_id
       WHERE dp.id = $1 AND dp.is_active = true AND n.is_active = true AND p.is_active = true`,
      [planId]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plan not found or unavailable.' });
    }

    const chargeKobo = BigInt(Math.round(Number(plan.price) * 100));
    const providerCostKobo = BigInt(Math.round(Number(plan.provider_price) * 100));

    const walletResult = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const currentBalance = BigInt(walletResult.rows[0].balance);
    if (currentBalance < chargeKobo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    const newBalance = currentBalance - chargeKobo;
    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [newBalance.toString(), req.user.id]);

    const reference = `dataord_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, status)
       VALUES ($1, 'order_debit', $2, $3, $4, $5, 'success')`,
      [req.user.id, chargeKobo.toString(), currentBalance.toString(), newBalance.toString(), reference]
    );

    const requestId = buildRequestId();
    const orderResult = await client.query(
      `INSERT INTO data_orders (user_id, plan_id, phone_number, provider_request_id, charge, provider_cost, profit, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
      [req.user.id, plan.id, phoneNumber, requestId, chargeKobo.toString(), providerCostKobo.toString(), (chargeKobo - providerCostKobo).toString()]
    );
    const order = orderResult.rows[0];

    // Everything up to here is our own DB — safe to commit before calling the provider.
    await client.query('COMMIT');

    let purchaseResponse;
    try {
      const { client: providerClient } = await getProviderClient(plan.provider_row_id);
      purchaseResponse = await providerClient.purchase({
        requestId,
        vtpassServiceId: plan.vtpass_service_id,
        billersCode: phoneNumber,
        variationCode: plan.provider_variation_code,
        phone: phoneNumber,
      });
    } catch (err) {
      // A network/HTTP failure here does NOT necessarily mean VTPass didn't process it —
      // leave the order 'pending' rather than refunding immediately; the background
      // processor (services/dataOrderProcessor.js) requeries and resolves it either way.
      console.error('Data order provider call failed:', err.response?.data || err.message);
      await pool.query(`UPDATE data_orders SET provider_response = $1, updated_at = now() WHERE id = $2`, [
        JSON.stringify({ error: err.response?.data || err.message }), order.id,
      ]);
      return res.status(202).json({ ...order, message: 'Order received — confirming with the network, this updates automatically.' });
    }

    const txStatus = purchaseResponse?.content?.transactions?.status;
    await finalizeOrderFromProviderResponse(order.id, purchaseResponse);

    if (txStatus === 'delivered' || purchaseResponse?.code === '000') {
      return res.status(201).json({ ...order, status: 'completed', message: 'Data delivered.' });
    }
    // 'pending', 'initiated', or anything else uncertain — background processor resolves it.
    return res.status(202).json({ ...order, status: 'pending', message: 'Order received — confirming with the network, this updates automatically.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Data order error:', err.message);
    res.status(500).json({ error: 'Could not place order.' });
  } finally {
    client.release();
  }
});

// Shared between the purchase route and the background requery processor — applies a
// VTPass response to a data_orders row consistently, refunding on a confirmed failure.
// Exported so services/dataOrderProcessor.js uses the exact same logic, not a re-implementation.
async function finalizeOrderFromProviderResponse(orderId, providerResponse) {
  const status = providerResponse?.content?.transactions?.status;
  const providerTransactionId = providerResponse?.content?.transactions?.transactionId || null;

  if (status === 'delivered') {
    await pool.query(
      `UPDATE data_orders SET status = 'completed', provider_transaction_id = $1, provider_response = $2, updated_at = now() WHERE id = $3`,
      [providerTransactionId, JSON.stringify(providerResponse), orderId]
    );
    return 'completed';
  }
  if (status === 'failed') {
    const orderResult = await pool.query('SELECT user_id, charge FROM data_orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];
    if (order) await refundDataOrder(orderId, order.user_id, order.charge);
    await pool.query(
      `UPDATE data_orders SET status = 'failed', provider_transaction_id = $1, provider_response = $2, updated_at = now() WHERE id = $3`,
      [providerTransactionId, JSON.stringify(providerResponse), orderId]
    );
    return 'failed';
  }
  // 'pending' or unrecognized — leave as pending, provider_response updated for visibility
  await pool.query(`UPDATE data_orders SET provider_response = $1, updated_at = now() WHERE id = $2`, [
    JSON.stringify(providerResponse), orderId,
  ]);
  return 'pending';
}

// Compensating refund for a confirmed-failed order. Mirrors the pattern in
// routes/logProducts.js's refundLogOrder.
async function refundDataOrder(orderId, userId, chargeKobo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const walletResult = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const currentBalance = BigInt(walletResult.rows[0].balance);
    const chargeKoboBig = BigInt(chargeKobo);
    const newBalance = currentBalance + chargeKoboBig;

    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [newBalance.toString(), userId]);

    const reference = `datarefund_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, status, metadata)
       VALUES ($1, 'refund', $2, $3, $4, $5, 'success', $6)`,
      [userId, chargeKobo.toString(), currentBalance.toString(), newBalance.toString(), reference, JSON.stringify({ data_order_id: orderId })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Refund failed for data order ${orderId}:`, err.message);
  } finally {
    client.release();
  }
}

// GET /api/plans/orders — the logged-in user's own order history
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ord.id, ord.phone_number, ord.charge, ord.status, ord.created_at,
              dp.raw_name, dp.data_size, dp.duration, n.name AS network_name
       FROM data_orders ord
       JOIN data_plans dp ON dp.id = ord.plan_id
       JOIN networks n ON n.id = dp.network_id
       WHERE ord.user_id = $1 ORDER BY ord.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Orders fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch orders.' });
  }
});

module.exports = router;
module.exports.finalizeOrderFromProviderResponse = finalizeOrderFromProviderResponse;
module.exports.refundDataOrder = refundDataOrder;
