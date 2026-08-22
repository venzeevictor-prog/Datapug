const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { parseUserAgent } = require('../services/uaParser');
const { lookupGeo } = require('../services/geoLookup');

const router = express.Router();

// Decodes a JWT if one is present, but never rejects the request for a missing or
// invalid token — tracking has to work for logged-out visitors too. Attaches
// req.user only when a valid token is found.
function softAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // Ignore — an expired/invalid token just means we track the visit as anonymous.
    }
  }
  next();
}

// POST /api/track — page view beacon fired by public/js/track.js on every page load.
// Responds immediately (this must never add latency to page loads) and does the
// slower geo lookup + insert in the background.
router.post('/', softAuth, (req, res) => {
  const { visitorId, path, referrer, screenWidth, screenHeight } = req.body || {};

  if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
    return res.status(204).end(); // silently drop malformed beacons — never error out on the client
  }

  res.status(202).json({ ok: true });

  // ---------- Background work (does not block the response above) ----------
  (async () => {
    try {
      const ua = req.headers['user-agent'] || '';
      const { deviceType, browser, browserVersion, os } = parseUserAgent(ua);
      const ip = req.ip || req.connection?.remoteAddress || null;
      const geo = await lookupGeo(ip);

      await pool.query(
        `INSERT INTO page_views
           (visitor_id, user_id, path, referrer, ip_address, device_type, browser, browser_version, os,
            country, region, city, screen_width, screen_height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          String(visitorId).slice(0, 64),
          req.user?.id || null,
          String(path || '/').slice(0, 500),
          referrer ? String(referrer).slice(0, 2000) : null,
          ip,
          deviceType,
          browser,
          browserVersion,
          os,
          geo.country,
          geo.region,
          geo.city,
          Number.isFinite(Number(screenWidth)) ? Number(screenWidth) : null,
          Number.isFinite(Number(screenHeight)) ? Number(screenHeight) : null,
        ]
      );
    } catch (err) {
      console.error('Page view tracking failed:', err.message);
    }
  })();
});

module.exports = router;
