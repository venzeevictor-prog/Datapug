const pool = require('../db/pool');
const { getProviderClient } = require('./providerRegistry');
const { finalizeOrderFromProviderResponse, refundDataOrder } = require('../routes/dataPlans');

// VTPass's own docs describe pending/timeout/no-response as normal possible outcomes of
// a purchase call — not edge cases. This is what actually resolves those: requeries every
// order still sitting 'pending', on a timer, independent of whether anyone is watching.
const GIVE_UP_AFTER_MS = 2 * 60 * 60 * 1000; // requery for up to 2h before treating it as failed and refunding

async function processPendingOrders() {
  let orders;
  try {
    const result = await pool.query(
      `SELECT do.id, do.provider_request_id, do.user_id, do.charge, do.created_at, dp.provider_id
       FROM data_orders do JOIN data_plans dp ON dp.id = do.plan_id
       WHERE do.status = 'pending'
       ORDER BY do.created_at ASC LIMIT 100`
    );
    orders = result.rows;
  } catch (err) {
    console.error('Data order processor: could not load pending orders:', err.message);
    return;
  }

  for (const order of orders) {
    try {
      const { client: providerClient } = await getProviderClient(order.provider_id);
      const response = await providerClient.requery(order.provider_request_id);
      const outcome = await finalizeOrderFromProviderResponse(order.id, response);

      if (outcome === 'completed' || outcome === 'failed') {
        console.log(`Data order processor: order ${order.id} resolved -> ${outcome}.`);
        continue;
      }

      // Still pending after requery — give up and refund if this has dragged on too long.
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (ageMs > GIVE_UP_AFTER_MS) {
        await refundDataOrder(order.id, order.user_id, order.charge);
        await pool.query(`UPDATE data_orders SET status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);
        console.error(`Data order processor: gave up on order ${order.id} after 2h, refunded.`);
      }
    } catch (err) {
      console.error(`Data order processor: error requerying order ${order.id}:`, err.response?.data || err.message);
    }
  }
}

function startDataOrderProcessor() {
  const INTERVAL_MS = 60 * 1000; // customers are waiting live for data — check every minute
  setInterval(() => {
    processPendingOrders().catch((err) => console.error('Data order processor error:', err.message));
  }, INTERVAL_MS);
  setTimeout(() => {
    processPendingOrders().catch((err) => console.error('Data order processor error:', err.message));
  }, 20 * 1000);
}

module.exports = { startDataOrderProcessor, processPendingOrders };
