// Thin wrapper around fetch that attaches the JWT and redirects to login on 401.
const API = {
  base: '/api',

  token() {
    return localStorage.getItem('dataplug_token');
  },

  setToken(token) {
    localStorage.setItem('dataplug_token', token);
  },

  clearToken() {
    localStorage.removeItem('dataplug_token');
    localStorage.removeItem('dataplug_user');
  },

  currentUser() {
    const raw = localStorage.getItem('dataplug_user');
    return raw ? JSON.parse(raw) : null;
  },

  setUser(user) {
    localStorage.setItem('dataplug_user', JSON.stringify(user));
  },

  async request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${this.base}${path}`, { ...options, headers, cache: 'no-store' });

    if (res.status === 401) {
      this.clearToken();
      // The homepage (/, /index.html) never calls authenticated endpoints, so this
      // only fires from app pages — send those back to the login page, not the
      // marketing homepage.
      if (!location.pathname.endsWith('login.html')) {
        location.href = '/login.html';
      }
      throw new Error('Session expired. Please log in again.');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Something went wrong.');
    }
    return data;
  },

  get(path) {
    return this.request(path, { method: 'GET' });
  },
  post(path, body) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
};

// Money is stored in kobo on the backend; this converts for display.
function formatNaira(kobo) {
  return (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
