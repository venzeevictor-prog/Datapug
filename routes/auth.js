const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../services/mailer');
const { REFERRAL_BONUS_KOBO } = require('../services/referral');

const router = express.Router();

// Throttle auth attempts to slow down credential-stuffing / brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again later.' },
});
// Tighter limit specifically for password reset requests — this is the route most
// attractive to abuse for email-bombing someone.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset requests. Try again later.' },
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ============ Signup / Login ============

router.post('/signup', authLimiter, async (req, res) => {
  const { username, email, password, referralCode } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-50 chars, letters/numbers/underscores only.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Username or email already in use.' });
    }

    // Referral code is OPTIONAL and silently ignored if invalid/unknown — a typo'd or
    // stale ?ref= link should never block someone from signing up.
    let referrerId = null;
    if (referralCode) {
      const referrerResult = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      referrerId = referrerResult.rows[0]?.id || null;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userResult = await client.query(
      `INSERT INTO users (username, email, password_hash, referred_by)
       VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, referral_code, created_at`,
      [username, email, passwordHash, referrerId]
    );
    const user = userResult.rows[0];

    // Every user gets a wallet at signup.
    await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);

    // Track the referral itself (for the reward to fire later once this user funds their
    // wallet — see services/referral.js). Referring yourself isn't possible since
    // referrerId comes from a DB lookup on a code that can't exist before this insert.
    if (referrerId) {
      await client.query(
        `INSERT INTO referrals (referrer_id, referred_id, reward_amount, status)
         VALUES ($1, $2, $3, 'pending')`,
        [referrerId, user.id, REFERRAL_BONUS_KOBO]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ token: issueToken(user), user });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  } finally {
    client.release();
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, email, password_hash, role, is_active, totp_enabled, referral_code FROM users WHERE username = $1 OR email = $1',
      [username]
    );
    const user = result.rows[0];

    // Generic error message on purpose — don't reveal whether username or password was wrong.
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is disabled. Contact support.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // If 2FA is enabled, don't issue the real session token yet — issue a short-lived
    // token that only proves "password was correct" and requires a second step.
    if (user.totp_enabled) {
      const tempToken = jwt.sign({ id: user.id, purpose: '2fa_pending' }, process.env.JWT_SECRET, {
        expiresIn: '5m',
      });
      return res.json({ requires2fa: true, tempToken });
    }

    res.json({
      token: issueToken(user),
      user: { id: user.id, username: user.username, email: user.email, role: user.role, referral_code: user.referral_code },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/2fa/login-verify — second step of login when 2FA is enabled.
// Accepts either a live TOTP code or a one-time backup code.
router.post('/2fa/login-verify', authLimiter, async (req, res) => {
  const { tempToken, code } = req.body;
  if (!tempToken || !code) {
    return res.status(400).json({ error: 'tempToken and code are required.' });
  }

  let payload;
  try {
    payload = jwt.verify(tempToken, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Login session expired. Please log in again.' });
  }
  if (payload.purpose !== '2fa_pending') {
    return res.status(401).json({ error: 'Invalid session.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, username, email, role, totp_secret, totp_backup_codes, referral_code FROM users WHERE id = $1',
      [payload.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found.' });

    const validTotp = authenticator.check(String(code).trim(), user.totp_secret);

    let validBackup = false;
    let remainingCodes = user.totp_backup_codes || [];
    if (!validTotp && remainingCodes.length > 0) {
      for (let i = 0; i < remainingCodes.length; i++) {
        if (await bcrypt.compare(String(code).trim(), remainingCodes[i])) {
          validBackup = true;
          remainingCodes = [...remainingCodes.slice(0, i), ...remainingCodes.slice(i + 1)];
          break;
        }
      }
    }

    if (!validTotp && !validBackup) {
      return res.status(401).json({ error: 'Invalid code.' });
    }

    if (validBackup) {
      await pool.query('UPDATE users SET totp_backup_codes = $1 WHERE id = $2', [remainingCodes, user.id]);
    }

    res.json({
      token: issueToken(user),
      user: { id: user.id, username: user.username, email: user.email, role: user.role, referral_code: user.referral_code },
      backupCodeUsed: validBackup,
    });
  } catch (err) {
    console.error('2FA login verify error:', err.message);
    res.status(500).json({ error: 'Could not verify code.' });
  }
});

// ============ Password reset ============

// POST /api/auth/forgot-password — always responds the same way regardless of whether
// the email exists, so this endpoint can't be used to enumerate registered accounts.
router.post('/forgot-password', resetLimiter, async (req, res) => {
  const { email } = req.body;
  const genericResponse = { message: 'If that email is registered, a reset link has been sent.' };

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  try {
    const userResult = await pool.query('SELECT id, username FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];
    if (!user) return res.json(genericResponse); // don't reveal non-existence

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${process.env.APP_URL || ''}/reset-password.html?token=${rawToken}`;
    await sendMail({
      to: email,
      subject: 'Reset your DataPlug password',
      text: `Hi ${user.username}, reset your password here (valid for 1 hour): ${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Hi ${user.username},</p><p>Reset your password using the link below (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
    });

    res.json(genericResponse);
  } catch (err) {
    console.error('Forgot password error:', err.message);
    // Still return the generic message — don't leak internal errors on this endpoint either.
    res.json(genericResponse);
  }
});

// POST /api/auth/reset-password — consumes a token and sets a new password
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenResult = await client.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [tokenHash]
    );
    const resetToken = tokenResult.rows[0];
    if (!resetToken) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [
      passwordHash,
      resetToken.user_id,
    ]);
    await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [resetToken.id]);
    // Invalidate any other outstanding reset tokens for this user.
    await client.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [resetToken.user_id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Password updated. You can now log in with your new password.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  } finally {
    client.release();
  }
});

// ============ 2FA management (requires an active session) ============

// POST /api/auth/2fa/setup — generates a new secret and QR code. Not enabled until /2fa/verify succeeds.
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2', [
      secret,
      req.user.id,
    ]);

    const otpauth = authenticator.keyuri(req.user.username, 'DataPlug', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    res.json({ secret, qrDataUrl });
  } catch (err) {
    console.error('2FA setup error:', err.message);
    res.status(500).json({ error: 'Could not start 2FA setup.' });
  }
});

// POST /api/auth/2fa/verify — confirms the user's authenticator app is working, enables 2FA,
// and issues one-time backup codes (shown ONCE — we only ever store their hashes).
router.post('/2fa/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required.' });

  try {
    const userResult = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    const secret = userResult.rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ error: 'Run /2fa/setup first.' });

    const valid = authenticator.check(String(code).trim(), secret);
    if (!valid) return res.status(400).json({ error: 'Invalid code. Check your authenticator app and try again.' });

    const backupCodes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
    const hashedCodes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));

    await pool.query('UPDATE users SET totp_enabled = true, totp_backup_codes = $1 WHERE id = $2', [
      hashedCodes,
      req.user.id,
    ]);

    res.json({ message: '2FA enabled.', backupCodes });
  } catch (err) {
    console.error('2FA verify error:', err.message);
    res.status(500).json({ error: 'Could not enable 2FA.' });
  }
});

// POST /api/auth/2fa/disable — requires current password AND a valid code, so a stolen
// session token alone can't be used to turn off 2FA and lock the real owner out.
router.post('/2fa/disable', requireAuth, async (req, res) => {
  const { password, code } = req.body;
  if (!password || !code) {
    return res.status(400).json({ error: 'password and code are required.' });
  }

  try {
    const userResult = await pool.query(
      'SELECT password_hash, totp_secret FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Incorrect password.' });

    const validCode = authenticator.check(String(code).trim(), user.totp_secret);
    if (!validCode) return res.status(400).json({ error: 'Invalid code.' });

    await pool.query(
      'UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_backup_codes = NULL WHERE id = $1',
      [req.user.id]
    );
    res.json({ message: '2FA disabled.' });
  } catch (err) {
    console.error('2FA disable error:', err.message);
    res.status(500).json({ error: 'Could not disable 2FA.' });
  }
});

// GET /api/auth/me — current session's user + 2FA status, used by the frontend settings page
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, totp_enabled, referral_code, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Me fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch account.' });
  }
});

module.exports = router;
