const axios = require('axios');

// Best-effort IP → location lookup for website stats. Uses ip-api.com's free tier
// (no key required, generous rate limit, fine for a single panel's traffic).
// Swap the provider here if you outgrow the free tier — nothing else needs to change.
//
// This must NEVER throw and must NEVER slow down the request that triggered it:
// callers should treat a null return as "location unknown" and move on.
const TIMEOUT_MS = 2500;

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^fc00:/, /^fe80:/,
];

function isPrivateIp(ip) {
  if (!ip) return true;
  return PRIVATE_IP_PATTERNS.some((re) => re.test(ip));
}

async function lookupGeo(ipRaw) {
  try {
    // req.ip can come back as "::ffff:1.2.3.4" behind some proxies — normalize it.
    const ip = (ipRaw || '').replace(/^::ffff:/, '');
    if (isPrivateIp(ip)) return { country: null, region: null, city: null };

    const { data } = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
      params: { fields: 'status,country,regionName,city' },
      timeout: TIMEOUT_MS,
    });

    if (data && data.status === 'success') {
      return { country: data.country || null, region: data.regionName || null, city: data.city || null };
    }
    return { country: null, region: null, city: null };
  } catch (err) {
    return { country: null, region: null, city: null };
  }
}

module.exports = { lookupGeo, isPrivateIp };
