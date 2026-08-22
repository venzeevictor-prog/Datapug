const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../middleware/permissions');

const router = express.Router();

// Shared access check: a customer may only touch their own conversation;
// staff with 'support.respond' may touch any conversation.
async function loadConversationWithAccess(req, res) {
  const result = await pool.query('SELECT * FROM support_conversations WHERE id = $1', [req.params.id]);
  const convo = result.rows[0];
  if (!convo) {
    res.status(404).json({ error: 'Conversation not found.' });
    return null;
  }
  const isOwner = convo.user_id === req.user.id;
  const isStaffWithAccess = hasPermission(req.user.role, 'support.respond');
  if (!isOwner && !isStaffWithAccess) {
    res.status(403).json({ error: 'You do not have access to this conversation.' });
    return null;
  }
  return convo;
}

// POST /api/support/conversations — customer starts (or resumes) a conversation.
// If the customer already has an open conversation, returns that instead of creating a new one,
// so someone spamming "New chat" doesn't fragment their history across agents.
router.post('/conversations', requireAuth, async (req, res) => {
  const { subject, message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required to start a conversation.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT * FROM support_conversations WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    let convo = existing.rows[0];
    if (!convo) {
      const created = await client.query(
        `INSERT INTO support_conversations (user_id, subject) VALUES ($1, $2) RETURNING *`,
        [req.user.id, subject || null]
      );
      convo = created.rows[0];
    }

    await client.query(
      `INSERT INTO support_messages (conversation_id, sender_id, sender_role, body, read_by_customer)
       VALUES ($1, $2, $3, $4, true)`,
      [convo.id, req.user.id, req.user.role, message.trim()]
    );
    await client.query(
      `UPDATE support_conversations SET last_message_at = now() WHERE id = $1`,
      [convo.id]
    );

    await client.query('COMMIT');
    res.status(201).json(convo);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Start conversation error:', err.message);
    res.status(500).json({ error: 'Could not start conversation.' });
  } finally {
    client.release();
  }
});

// GET /api/support/conversations/mine — the logged-in customer's conversations
router.get('/conversations/mine', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM support_conversations WHERE user_id = $1 ORDER BY last_message_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('My conversations error:', err.message);
    res.status(500).json({ error: 'Could not fetch conversations.' });
  }
});

// GET /api/support/conversations — staff inbox: all conversations, optionally filtered by status
router.get('/conversations', requireAuth, requirePermission('support.respond'), async (req, res) => {
  const { status } = req.query;
  try {
    const result = status
      ? await pool.query(
          `SELECT c.*, u.username, u.email FROM support_conversations c
           JOIN users u ON u.id = c.user_id WHERE c.status = $1 ORDER BY c.last_message_at DESC`,
          [status]
        )
      : await pool.query(
          `SELECT c.*, u.username, u.email FROM support_conversations c
           JOIN users u ON u.id = c.user_id ORDER BY c.last_message_at DESC`
        );
    res.json(result.rows);
  } catch (err) {
    console.error('Staff inbox error:', err.message);
    res.status(500).json({ error: 'Could not fetch conversations.' });
  }
});

// GET /api/support/conversations/:id/messages — poll for messages, optionally only newer than ?since=
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const convo = await loadConversationWithAccess(req, res);
  if (!convo) return;

  const { since } = req.query;
  try {
    const result = since
      ? await pool.query(
          `SELECT sm.*, u.username AS sender_username FROM support_messages sm
           JOIN users u ON u.id = sm.sender_id
           WHERE sm.conversation_id = $1 AND sm.created_at > $2 ORDER BY sm.created_at ASC`,
          [req.params.id, since]
        )
      : await pool.query(
          `SELECT sm.*, u.username AS sender_username FROM support_messages sm
           JOIN users u ON u.id = sm.sender_id
           WHERE sm.conversation_id = $1 ORDER BY sm.created_at ASC LIMIT 200`,
          [req.params.id]
        );

    // Mark messages as read by whichever side is fetching.
    const isOwner = convo.user_id === req.user.id;
    await pool.query(
      `UPDATE support_messages SET ${isOwner ? 'read_by_customer' : 'read_by_agent'} = true
       WHERE conversation_id = $1`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Fetch messages error:', err.message);
    res.status(500).json({ error: 'Could not fetch messages.' });
  }
});

// POST /api/support/conversations/:id/messages — send a message in an existing conversation
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const convo = await loadConversationWithAccess(req, res);
  if (!convo) return;

  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required.' });
  }
  if (convo.status === 'closed') {
    return res.status(400).json({ error: 'This conversation is closed.' });
  }

  const isOwner = convo.user_id === req.user.id;

  try {
    const result = await pool.query(
      `INSERT INTO support_messages (conversation_id, sender_id, sender_role, body, read_by_customer, read_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, req.user.id, req.user.role, message.trim(), isOwner, !isOwner]
    );

    // Auto-assign the conversation to whichever agent replies first, if unassigned.
    if (!isOwner && !convo.assigned_agent_id) {
      await pool.query('UPDATE support_conversations SET assigned_agent_id = $1 WHERE id = $2', [
        req.user.id,
        req.params.id,
      ]);
    }
    await pool.query('UPDATE support_conversations SET last_message_at = now() WHERE id = $1', [req.params.id]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Send message error:', err.message);
    res.status(500).json({ error: 'Could not send message.' });
  }
});

// PATCH /api/support/conversations/:id/close — staff closes a conversation
router.patch('/conversations/:id/close', requireAuth, requirePermission('support.close'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE support_conversations SET status = 'closed' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Close conversation error:', err.message);
    res.status(500).json({ error: 'Could not close conversation.' });
  }
});

module.exports = router;
