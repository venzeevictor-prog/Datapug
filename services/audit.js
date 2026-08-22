const pool = require('../db/pool');

// Records a sensitive action for traceability. Never throws — a logging failure
// should never block the underlying action from completing.
async function logAction(actorId, action, targetType, targetId, details = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, targetType, String(targetId), JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
