const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, ROLES, hasPermission } = require('../middleware/permissions');
const { refundDataOrder } = require('../routes/dataPlans');
const { logAction } = require('../services/audit');

const router = express.Router();

// ============ Users ============

// GET /api/admin/users — list all customers (with wallet balance), for support/admin/super_admin
router.get('/users', requireAuth, requirePermission('users.view_all'), async (req, res) => {
  const search = req.query.search ? `%${req.query.search}%` : null;
  try {
    const result = search
      ? await pool.query(
          `SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at, w.balance
           FROM users u LEFT JOIN wallets w ON w.user_id = u.id
           WHERE u.username ILIKE $1 OR u.email ILIKE $1
           ORDER BY u.created_at DESC LIMIT 100`,
          [search]
        )
      : await pool.query(
          `SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at, w.balance
           FROM users u LEFT JOIN wallets w ON w.user_id = u.id
           ORDER BY u.created_at DESC LIMIT 100`
        );
    res.json(result.rows);
  } catch (err) {
    console.error('Admin users list error:', err.message);
    res.status(500).json({ error: 'Could not fetch users.' });
  }
});

// GET /api/admin/users/:id — full detail: orders, transactions, wallet
router.get('/users/:id', requireAuth, requirePermission('users.view_all'), async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at, w.balance
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`,
      [req.params.id]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const orders = await pool.query(
      `SELECT do.id, do.phone_number, do.charge, do.status, do.created_at, dp.raw_name AS plan_name, n.name AS network_name
       FROM data_orders do JOIN data_plans dp ON dp.id = do.plan_id JOIN networks n ON n.id = dp.network_id
       WHERE do.user_id = $1 ORDER BY do.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const transactions = await pool.query(
      `SELECT id, type, amount, balance_after, status, reference, created_at
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json({ ...user, orders: orders.rows, transactions: transactions.rows });
  } catch (err) {
    console.error('Admin user detail error:', err.message);
    res.status(500).json({ error: 'Could not fetch user detail.' });
  }
});

// PATCH /api/admin/users/:id/status — suspend or reactivate an account
router.patch('/users/:id/status', requireAuth, requirePermission('users.suspend'), async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be true or false.' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING id, username, is_active',
      [is_active, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    await logAction(req.user.id, is_active ? 'user.reactivate' : 'user.suspend', 'user', req.params.id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Suspend/reactivate error:', err.message);
    res.status(500).json({ error: 'Could not update account status.' });
  }
});

// PATCH /api/admin/users/:id/role — change a user's role (super_admin only)
router.patch('/users/:id/role', requireAuth, requirePermission('users.manage_roles'), async (req, res) => {
  const { role } = req.body;
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role.' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, username, role',
      [role, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    await logAction(req.user.id, 'user.role_change', 'user', req.params.id, { new_role: role });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Role change error:', err.message);
    res.status(500).json({ error: 'Could not update role.' });
  }
});

// ============ Wallet adjustments ============

// POST /api/admin/users/:id/wallet-adjust — manually credit or debit a customer's wallet
// (e.g. goodwill credit, correcting a support issue). Always logged to audit_log.
router.post('/users/:id/wallet-adjust', requireAuth, requirePermission('transactions.adjust'), async (req, res) => {
  const { amountNaira, reason } = req.body;
  const amount = Number(amountNaira);

  if (!amount || amount === 0) {
    return res.status(400).json({ error: 'amountNaira must be a non-zero number (negative to debit).' });
  }
  if (!reason || reason.trim().length < 3) {
    return res.status(400).json({ error: 'A reason is required for wallet adjustments.' });
  }

  const koboAmount = BigInt(Math.round(amount * 100));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!walletResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User wallet not found.' });
    }
    // BUG FIX: balance is a BIGINT column — `pg` returns it as a JS string, so
    // `currentBalance + koboAmount` was STRING CONCATENATION, not addition
    // (e.g. "9080" + 10000 -> "908010000" instead of 19080). Convert to BigInt first.
    const currentBalance = BigInt(walletResult.rows[0].balance);
    const newBalance = currentBalance + koboAmount;

    if (newBalance < 0n) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Adjustment would make balance negative.' });
    }

    await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
      newBalance.toString(),
      req.params.id,
    ]);

    const absKobo = koboAmount < 0n ? -koboAmount : koboAmount;
    const reference = `adjust_${req.params.id}_${Date.now()}`;
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference, status, metadata)
       VALUES ($1, 'adjustment', $2, $3, $4, $5, 'success', $6)`,
      [
        req.params.id,
        absKobo.toString(),
        currentBalance.toString(),
        newBalance.toString(),
        reference,
        JSON.stringify({ reason, direction: koboAmount > 0n ? 'credit' : 'debit', admin_id: req.user.id }),
      ]
    );

    await client.query('COMMIT');

    await logAction(req.user.id, 'wallet.adjust', 'user', req.params.id, {
      amountNaira: amount,
      reason,
      newBalance: newBalance.toString(), // BigInt isn't JSON-serializable — must stringify before logging/responding
    });

    res.json({ message: 'Wallet adjusted.', newBalance: newBalance.toString() });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Wallet adjust error:', err.message);
    res.status(500).json({ error: 'Could not adjust wallet.' });
  } finally {
    client.release();
  }
});

// ============ Orders (admin oversight) ============

// GET /api/admin/orders — view all data orders across all customers
router.get('/orders', requireAuth, requirePermission('orders.view_all'), async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const result = status
      ? await pool.query(
          `SELECT do.*, dp.raw_name AS plan_name, n.name AS network_name, u.username
           FROM data_orders do
           JOIN data_plans dp ON dp.id = do.plan_id JOIN networks n ON n.id = dp.network_id
           JOIN users u ON u.id = do.user_id
           WHERE do.status = $1 ORDER BY do.created_at DESC LIMIT $2`,
          [status, limit]
        )
      : await pool.query(
          `SELECT do.*, dp.raw_name AS plan_name, n.name AS network_name, u.username
           FROM data_orders do
           JOIN data_plans dp ON dp.id = do.plan_id JOIN networks n ON n.id = dp.network_id
           JOIN users u ON u.id = do.user_id
           ORDER BY do.created_at DESC LIMIT $1`,
          [limit]
        );
    res.json(result.rows);
  } catch (err) {
    console.error('Admin orders list error:', err.message);
    res.status(500).json({ error: 'Could not fetch orders.' });
  }
});

// POST /api/admin/orders/:id/refund — force-refund any customer's order (support escalation path)
router.post('/orders/:id/refund', requireAuth, requirePermission('orders.refund_any'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.trim().length < 3) {
    return res.status(400).json({ error: 'A reason is required for manual refunds.' });
  }
  try {
    const orderResult = await pool.query('SELECT * FROM data_orders WHERE id = $1', [req.params.id]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'failed') {
      return res.status(400).json({ error: 'Order was already refunded or failed.' });
    }

    await refundDataOrder(order.id, order.user_id, order.charge);
    await pool.query(`UPDATE data_orders SET status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);

    await logAction(req.user.id, 'order.refund', 'data_order', req.params.id, { reason });
    res.json({ message: 'Order refunded.' });
  } catch (err) {
    console.error('Admin refund error:', err.message);
    res.status(500).json({ error: 'Could not refund order.' });
  }
});

// ============ Referral program (admin oversight) ============

// GET /api/admin/referrals — every referral, who referred whom, and reward status
router.get('/referrals', requireAuth, requirePermission('users.view_all'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.reward_amount, r.status, r.created_at, r.rewarded_at,
              ru.username AS referrer_username, rd.username AS referred_username
       FROM referrals r
       JOIN users ru ON ru.id = r.referrer_id
       JOIN users rd ON rd.id = r.referred_id
       ORDER BY r.created_at DESC LIMIT 200`
    );
    const summary = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'rewarded') AS rewarded_count,
              COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
              COALESCE(SUM(reward_amount) FILTER (WHERE status = 'rewarded'), 0) AS total_paid_out
       FROM referrals`
    );
    res.json({ referrals: result.rows, summary: summary.rows[0] });
  } catch (err) {
    console.error('Admin referrals fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch referrals.' });
  }
});

// ============ Analytics (revenue / cost / profit) ============

// GET /api/admin/analytics — overall and per-network profit reporting.
router.get('/analytics', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(charge), 0) AS total_revenue,
         COALESCE(SUM(provider_cost), 0) AS total_cost,
         COALESCE(SUM(profit), 0) AS total_profit,
         COUNT(*) AS order_count
       FROM data_orders WHERE status = 'completed'`
    );

    const last30Days = await pool.query(
      `SELECT
         COALESCE(SUM(charge), 0) AS total_revenue,
         COALESCE(SUM(provider_cost), 0) AS total_cost,
         COALESCE(SUM(profit), 0) AS total_profit,
         COUNT(*) AS order_count
       FROM data_orders
       WHERE status = 'completed' AND created_at > now() - interval '30 days'`
    );

    const byNetwork = await pool.query(
      `SELECT n.name AS network_name,
              SUM(do.charge) AS revenue, SUM(do.provider_cost) AS cost, SUM(do.profit) AS profit,
              COUNT(*) AS order_count
       FROM data_orders do
       JOIN data_plans dp ON dp.id = do.plan_id
       JOIN networks n ON n.id = dp.network_id
       WHERE do.status = 'completed'
       GROUP BY n.id, n.name
       ORDER BY profit DESC`
    );

    const canSeeCost = hasPermission(req.user.role, 'costs.view_exact');
    const stripCost = ({ total_cost, ...rest }) => rest;
    const stripCostRow = ({ cost, ...rest }) => rest;

    res.json({
      allTime: canSeeCost ? totals.rows[0] : stripCost(totals.rows[0]),
      last30Days: canSeeCost ? last30Days.rows[0] : stripCost(last30Days.rows[0]),
      byNetwork: canSeeCost ? byNetwork.rows : byNetwork.rows.map(stripCostRow),
    });
  } catch (err) {
    console.error('Analytics fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch analytics.' });
  }
});

// GET /api/admin/analytics/daily?days=30 — one row per day: orders, revenue, profit, new
// signups. This is what powers the daily bar/line charts on the stats dashboard.
router.get('/analytics/daily', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  try {
    const orders = await pool.query(
      `SELECT date_trunc('day', created_at) AS day,
              COUNT(*) AS order_count,
              COALESCE(SUM(charge), 0) AS revenue,
              COALESCE(SUM(profit), 0) AS profit
       FROM data_orders
       WHERE status = 'completed' AND created_at > now() - ($1 || ' days')::interval
       GROUP BY day ORDER BY day ASC`,
      [days]
    );
    const signups = await pool.query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*) AS signups
       FROM users
       WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY day ORDER BY day ASC`,
      [days]
    );
    const canSeeCost = hasPermission(req.user.role, 'costs.view_exact');
    res.json({
      orders: canSeeCost ? orders.rows : orders.rows.map(({ profit, ...rest }) => rest),
      signups: signups.rows,
    });
  } catch (err) {
    console.error('Daily analytics fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch daily analytics.' });
  }
});

// GET /api/admin/analytics/monthly?months=12 — one row per month, same shape as daily
router.get('/analytics/monthly', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 12, 36);
  try {
    const orders = await pool.query(
      `SELECT date_trunc('month', created_at) AS month,
              COUNT(*) AS order_count,
              COALESCE(SUM(charge), 0) AS revenue,
              COALESCE(SUM(profit), 0) AS profit
       FROM data_orders
       WHERE status = 'completed' AND created_at > now() - ($1 || ' months')::interval
       GROUP BY month ORDER BY month ASC`,
      [months]
    );
    const signups = await pool.query(
      `SELECT date_trunc('month', created_at) AS month, COUNT(*) AS signups
       FROM users
       WHERE created_at > now() - ($1 || ' months')::interval
       GROUP BY month ORDER BY month ASC`,
      [months]
    );
    const canSeeCost = hasPermission(req.user.role, 'costs.view_exact');
    res.json({
      orders: canSeeCost ? orders.rows : orders.rows.map(({ profit, ...rest }) => rest),
      signups: signups.rows,
    });
  } catch (err) {
    console.error('Monthly analytics fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch monthly analytics.' });
  }
});

// GET /api/admin/analytics/range?from=YYYY-MM-DD&to=YYYY-MM-DD — custom date range,
// grouped by day within that range. Powers the date-range picker on the stats dashboard.
router.get('/analytics/range', requireAuth, requirePermission('analytics.view'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD dates.' });
  }
  try {
    const orders = await pool.query(
      `SELECT date_trunc('day', created_at) AS day,
              COUNT(*) AS order_count,
              COALESCE(SUM(charge), 0) AS revenue,
              COALESCE(SUM(profit), 0) AS profit
       FROM data_orders
       WHERE status = 'completed' AND created_at >= $1::date AND created_at < ($2::date + interval '1 day')
       GROUP BY day ORDER BY day ASC`,
      [from, to]
    );
    const canSeeCost = hasPermission(req.user.role, 'costs.view_exact');
    res.json({ orders: canSeeCost ? orders.rows : orders.rows.map(({ profit, ...rest }) => rest) });
  } catch (err) {
    console.error('Range analytics fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch analytics for that range.' });
  }
});

// ============ Website stats ============
// Traffic analytics from public/js/track.js beacons: page views, unique visitors,
// device/browser/OS/location breakdowns, and a raw recent-visits feed.
// IPs are masked to the /24 (last octet dropped) before leaving the server — enough
// to spot abuse patterns without storing/exposing a precise per-visitor identifier.
function maskIp(ip) {
  if (!ip) return null;
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.xxx');
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + ':xxxx';
  return ip;
}

router.get('/webstats', requireAuth, requirePermission('webstats.view'), async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM page_views) AS views,
         (SELECT COUNT(DISTINCT visitor_id) FROM page_views) AS unique_visitors,
         (SELECT COUNT(*) FROM page_views WHERE created_at > now() - interval '30 days') AS views_30d,
         (SELECT COUNT(DISTINCT visitor_id) FROM page_views WHERE created_at > now() - interval '30 days') AS unique_visitors_30d,
         (SELECT COUNT(*) FROM page_views WHERE created_at > now() - interval '1 day') AS views_24h,
         (SELECT COUNT(DISTINCT visitor_id) FROM page_views WHERE created_at > now() - interval '1 day') AS unique_visitors_24h`
    );

    const topPages = await pool.query(
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS unique_visitors
       FROM page_views GROUP BY path ORDER BY views DESC LIMIT 10`
    );

    const devices = await pool.query(
      `SELECT COALESCE(device_type, 'unknown') AS device_type, COUNT(*) AS count
       FROM page_views GROUP BY device_type ORDER BY count DESC`
    );

    const browsers = await pool.query(
      `SELECT COALESCE(browser, 'Unknown') AS browser, COUNT(*) AS count
       FROM page_views GROUP BY browser ORDER BY count DESC LIMIT 10`
    );

    const operatingSystems = await pool.query(
      `SELECT COALESCE(os, 'Unknown') AS os, COUNT(*) AS count
       FROM page_views GROUP BY os ORDER BY count DESC LIMIT 10`
    );

    const locations = await pool.query(
      `SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS count, COUNT(DISTINCT visitor_id) AS unique_visitors
       FROM page_views GROUP BY country ORDER BY count DESC LIMIT 15`
    );

    const recent = await pool.query(
      `SELECT pv.id, pv.path, pv.referrer, pv.ip_address, pv.device_type, pv.browser, pv.browser_version,
              pv.os, pv.country, pv.region, pv.city, pv.created_at, u.username
       FROM page_views pv LEFT JOIN users u ON u.id = pv.user_id
       ORDER BY pv.created_at DESC LIMIT 100`
    );

    res.json({
      totals: totals.rows[0],
      topPages: topPages.rows,
      devices: devices.rows,
      browsers: browsers.rows,
      operatingSystems: operatingSystems.rows,
      locations: locations.rows,
      recent: recent.rows.map((r) => ({ ...r, ip_address: maskIp(r.ip_address) })),
    });
  } catch (err) {
    console.error('Webstats fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch website stats.' });
  }
});

// ============ Audit log ============

// GET /api/admin/audit-log — recent sensitive actions taken by staff
router.get('/audit-log', requireAuth, requirePermission('audit.view'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  try {
    const result = await pool.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.username AS actor_username
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Audit log fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch audit log.' });
  }
});

module.exports = router;
