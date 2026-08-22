require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const pool = require('./db/pool');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const dataPlansRoutes = require('./routes/dataPlans');
const adminRoutes = require('./routes/admin');
const supportRoutes = require('./routes/support');
const providersRoutes = require('./routes/providers');
const trackRoutes = require('./routes/track');

// ---------- Startup config validation ----------
// Fail fast and loud rather than running with a silently missing secret in production.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'PAYSTACK_SECRET_KEY'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is too short for production use (need 32+ random characters).');
  process.exit(1);
}

const app = express();

// Express generates an ETag for every JSON response by default and will reply 304
// (empty body) to a matching conditional GET — fine for static files, actively wrong
// for an API. Balances, orders, and service lists change server-side without the URL
// changing, so a browser or intermediate cache serving a stale 304 here isn't a cosmetic
// bug — it can show someone their OLD wallet balance or an empty service list after data
// has genuinely changed. Disable it globally; API responses are never meant to be cached.
app.set('etag', false);

// Render (and most PaaS) sit behind a reverse proxy — needed for correct client IPs
// in rate limiting and for secure cookies/redirects to behave correctly.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // the dashboard loads Google Fonts + inline scripts; tighten this with a real CSP once the frontend is finalized
}));

// Belt-and-suspenders on top of disabling etag: explicitly tell browsers and any
// intermediate proxy/CDN never to cache API responses at all.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Restrict CORS to your own frontend origin in production; wide open in development for convenience.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: process.env.NODE_ENV === 'production' && allowedOrigins.length > 0 ? allowedOrigins : true,
  credentials: true,
}));

// Global rate limit as a baseline defense-in-depth layer (auth routes have their own, stricter limit).
// Page-view tracking beacons are excluded — they fire on every page load across every
// visitor sharing the panel's IP/proxy, and shouldn't eat into the budget real API calls need.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/track',
}));

// Separate, more generous limit just for the tracking beacon — still bounded, so it
// can't be abused as a write-amplification vector against the database.
app.use('/api/track', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Paystack webhook needs the RAW body to verify the HMAC signature. express.json()
// below would otherwise re-read (and destroy) the already-consumed request stream
// for this path, so we explicitly skip it for /api/wallet/webhook.
app.use('/api/wallet/webhook', express.raw({ type: 'application/json' }));

app.use((req, res, next) => {
  if (req.path === '/api/wallet/webhook') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// ---------- Request logging ----------
// Minimal structured request log; swap for a real logger (pino/winston) if volume grows.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      userId: req.user?.id,
    }));
  });
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/plans', dataPlansRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/track', trackRoutes);

// ---------- SEO: fill in the real domain at request time ----------
// index.html, robots.txt, and sitemap.xml ship with a "SITE_URL" placeholder
// (see public/index.html, public/robots.txt, public/sitemap.xml) so canonical/OG
// tags and the sitemap point at wherever this is actually deployed, without a
// build step. Set APP_URL in your environment (e.g. https://fluttersocialservices.com,
// no trailing slash) before going live — see .env.example.
// These must be registered BEFORE express.static below, since static serving
// would otherwise answer "/" with the raw (placeholder-filled) index.html first.
const SITE_URL = (process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');

function serveWithSiteUrl(relPath, contentType) {
  return (req, res) => {
    fs.readFile(path.join(__dirname, 'public', relPath), 'utf8', (err, data) => {
      if (err) return res.status(404).end();
      res.type(contentType).send(data.replace(/https:\/\/SITE_URL/g, SITE_URL).replace(/SITE_URL/g, SITE_URL.replace(/^https?:\/\//, '')));
    });
  };
}

app.get(['/', '/index.html'], serveWithSiteUrl('index.html', 'html'));
app.get('/login.html', serveWithSiteUrl('login.html', 'html'));
app.get('/about.html', serveWithSiteUrl('about.html', 'html'));
app.get('/contact.html', serveWithSiteUrl('contact.html', 'html'));
app.get('/robots.txt', serveWithSiteUrl('robots.txt', 'text/plain'));
app.get('/sitemap.xml', serveWithSiteUrl('sitemap.xml', 'application/xml'));

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Health check ----------
// Checks the DB connection too — a health check that only says "the process is alive"
// misses the most common real failure mode (DB unreachable).
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

// 404 for unmatched API routes (falls through to static/SPA handling for everything else)
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Catches funding payments that never got resolved via webhook or the user
// returning to the app (see services/reconcile.js for why this exists).
const { startReconciliationSweep } = require('./services/reconcile');
startReconciliationSweep();

// Resolves any data order VTPass left 'pending' — see services/dataOrderProcessor.js
// for why this is a real, expected case with VTPass, not just an edge case.
const { startDataOrderProcessor } = require('./services/dataOrderProcessor');
startDataOrderProcessor();

// ---------- Graceful shutdown ----------
// Render (and most orchestrators) send SIGTERM before killing a container on redeploy;
// without this, in-flight requests and DB transactions can be cut off mid-write.
function shutdown(signal) {
  console.log(`${signal} received: closing server gracefully...`);
  server.close(async () => {
    await pool.end();
    console.log('Server closed. Exiting.');
    process.exit(0);
  });
  // Force-exit if graceful shutdown hangs longer than 10s.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
