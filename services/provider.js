const axios = require('axios');

// VTPass uses THREE separate credentials, not one:
// - api-key + public-key: GET requests (variation codes, wallet balance)
// - api-key + secret-key: POST requests (purchase, requery)
// Source: https://vtpass.com/documentation/authentication/
function createProviderClient(providerRow) {
  if (providerRow.api_type !== 'vtpass') {
    throw new Error(`Unknown provider api_type: ${providerRow.api_type}`);
  }

  const baseURL = providerRow.api_url.replace(/\/+$/, '');
  const readHeaders = { 'api-key': providerRow.api_key, 'public-key': providerRow.public_key };
  const writeHeaders = { 'api-key': providerRow.api_key, 'secret-key': providerRow.secret_key };

  return {
    // Response: { response_description, content: { ServiceName, serviceID, variations: [{ variation_code, name, variation_amount, fixedPrice }] } }
    getVariations: (vtpassServiceId) =>
      axios
        .get(`${baseURL}/service-variations`, { params: { serviceID: vtpassServiceId }, headers: readHeaders })
        .then((r) => r.data),

    // request_id MUST be pre-built via buildRequestId() below — VTPass has strict format
    // rules (see https://vtpass.com/documentation/how-to-generate-request-id/) and a
    // malformed one is rejected outright.
    // Response: { code, response_description, content: { transactions: { status, ... } } }
    // status can be 'pending' as well as 'delivered'/'failed' — always requery to confirm
    // a pending result rather than treating the initial response as final.
    purchase: ({ requestId, vtpassServiceId, billersCode, variationCode, phone }) =>
      axios
        .post(
          `${baseURL}/pay`,
          { request_id: requestId, serviceID: vtpassServiceId, billersCode, variation_code: variationCode, phone },
          { headers: writeHeaders }
        )
        .then((r) => r.data),

    // Response shape matches purchase()'s — used to resolve a 'pending' result.
    requery: (requestId) =>
      axios.post(`${baseURL}/requery`, { request_id: requestId }, { headers: writeHeaders }).then((r) => r.data),

    // Response: { contents: { balance, ... } } — used for the admin "check balance" button.
    getProviderBalance: () =>
      axios.get(`${baseURL}/balance`, { headers: readHeaders }).then((r) => ({
        balance: r.data?.contents?.balance,
        currency: 'NGN',
      })),
  };
}

// Builds a VTPass-compliant request_id: first 12 chars must be numeric, today's date in
// Africa/Lagos time as YYYYMMDDHHII, with a random alphanumeric suffix for uniqueness.
function buildRequestId() {
  const now = new Date();
  // en-GB + explicit parts gives us Lagos-local Y/M/D/H/min without a timezone library —
  // Lagos has no DST, so this is safe year-round (unlike doing this trick for a DST zone).
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const stamp = `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${stamp}${suffix}`;
}

// VTPass gives plan names as free text, e.g.:
//   "N100 100MB - 24 hrs"                         -> daily, out of scope for this site
//   "N1500 6GB - 7 days" / "MTN N300 Xtratalk Weekly Bundle"  -> weekly
//   "N1000 1.5GB - 30 days" / "...(1 Month)"       -> monthly
//   "MTN N50,000 165GB SME Mobile Data (2-Months)" / "...3-Month Plan" -> 2-3months
// This is inferred from text, not an authoritative field — spot-check the sync results.
function classifyDuration(name) {
  const n = name.toLowerCase();
  if (/\b(2|3)[\s-]?month/.test(n) || /2-3\s?month/.test(n)) return '2-3months';
  if (/\bweekly\b|\b7\s?days?\b/.test(n)) return 'weekly';
  if (/\bmonthly\b|\b1\s?month\b|\b30\s?days?\b/.test(n)) return 'monthly';
  if (/\bdaily\b|\b24\s?h(ou)?rs?\b|\b1\s?day\b/.test(n)) return 'daily';
  return 'other'; // 1-year plans, anything that didn't match a known pattern — hidden by default, see routes/dataPlans.js sync
}

// Pulls a human-readable data size out of the name for display, e.g. "6GB" from
// "N1500 6GB - 7 days". Returns null if nothing GB/MB-shaped is found — the raw name is
// always kept as a fallback (see data_plans.raw_name).
function extractDataSize(name) {
  const match = name.match(/(\d+(?:\.\d+)?\s?(?:GB|MB|TB))/i);
  return match ? match[1].replace(/\s+/, '') : null;
}

module.exports = { createProviderClient, buildRequestId, classifyDuration, extractDataSize };
