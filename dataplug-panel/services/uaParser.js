// Minimal, dependency-free User-Agent parser for website stats.
// This isn't trying to be exhaustive (that's what ua-parser-js is for) — it covers
// the browsers/OSes/device types that make up the overwhelming majority of real
// traffic, which is all a "website stats" dashboard needs.

function parseDevice(ua) {
  if (!ua) return 'unknown';
  const s = ua.toLowerCase();
  if (/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|pingdom|uptimerobot/.test(s)) return 'bot';
  if (/ipad|tablet(?!.*mobile)|kindle|playbook|silk/.test(s)) return 'tablet';
  if (/mobile|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini/.test(s)) return 'mobile';
  return 'desktop';
}

function parseBrowser(ua) {
  if (!ua) return { browser: 'Unknown', version: '' };
  // Order matters: Edge/OPR/Chrome all include "Safari" and often "Chrome" in their UA string.
  const patterns = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['Chrome', /Chrome\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
    ['Internet Explorer', /(?:MSIE |rv:)([\d.]+).*Trident/],
  ];
  for (const [name, re] of patterns) {
    const m = ua.match(re);
    if (m) return { browser: name, version: m[1].split('.').slice(0, 2).join('.') };
  }
  return { browser: 'Other', version: '' };
}

function parseOS(ua) {
  if (!ua) return 'Unknown';
  if (/windows nt 10/i.test(ua)) return 'Windows 10/11';
  if (/windows nt 6\.3/i.test(ua)) return 'Windows 8.1';
  if (/windows nt 6\.1/i.test(ua)) return 'Windows 7';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/cros/i.test(ua)) return 'Chrome OS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Other';
}

function parseUserAgent(ua) {
  const { browser, version } = parseBrowser(ua || '');
  return {
    deviceType: parseDevice(ua || ''),
    browser,
    browserVersion: version,
    os: parseOS(ua || ''),
  };
}

module.exports = { parseUserAgent };
