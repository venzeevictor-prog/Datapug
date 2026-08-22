// ---------- Website stats: lightweight page view beacon ----------
// Fires once per page load. Never throws, never blocks rendering, and never
// delays navigation — analytics must not be able to break the product.
// The server fills in IP-derived device/browser/OS/location; this beacon only
// tells it *which* visitor and *which* page.
(function () {
  try {
    var VISITOR_KEY = 'dataplug_visitor_id';
    var visitorId = localStorage.getItem(VISITOR_KEY);
    if (!visitorId) {
      visitorId = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(VISITOR_KEY, visitorId);
    }

    var payload = JSON.stringify({
      visitorId: visitorId,
      path: location.pathname,
      referrer: document.referrer || null,
      screenWidth: window.screen ? window.screen.width : null,
      screenHeight: window.screen ? window.screen.height : null,
    });

    var token = localStorage.getItem('dataplug_token');
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    fetch('/api/track', {
      method: 'POST',
      headers: headers,
      body: payload,
      keepalive: true, // survives the page unloading, like navigator.sendBeacon
    }).catch(function () { /* analytics failures are silent by design */ });
  } catch (e) {
    // Never let a tracking bug affect the page.
  }
})();
