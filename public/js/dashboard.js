// ---------- Guard: must be logged in ----------
if (!API.token()) location.href = '/login.html';

const user = API.currentUser();
document.getElementById('sidebar-username').textContent = user ? `@${user.username}` : '';
if (user && ['support', 'admin', 'super_admin'].includes(user.role)) {
  document.getElementById('admin-portal-link').style.display = 'flex';
}

document.getElementById('logout-btn').addEventListener('click', () => {
  API.clearToken();
  location.href = '/login.html';
});

// ---------- Nav / view switching ----------
const navItems = document.querySelectorAll('.nav-item[data-view]');
const views = document.querySelectorAll('.view');

const mobileNavToggle = document.getElementById('nav-toggle');

navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    navItems.forEach((b) => b.classList.remove('active'));
    views.forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    if (mobileNavToggle) mobileNavToggle.checked = false; // close the mobile drawer after picking a view

    if (btn.dataset.view === 'orders') loadOrders();
    if (btn.dataset.view === 'transactions') loadTransactions();
    if (btn.dataset.view === 'order') { if (!plansLoaded) loadPlans(); else goToPlansScreen('networks'); }
    if (btn.dataset.view === 'referrals') loadReferrals();
  });
});

// ---------- Toast ----------
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${isError ? 'error' : ''}`;
  setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------- Status badge helper ----------
function statusBadge(status) {
  const clean = (status || 'pending').toLowerCase().replace(/\s+/g, '_');
  const label = clean.replace('_', ' ');
  return `<span class="badge ${clean}">${label}</span>`;
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
}

// VTPass's own plan names carry THEIR price embedded as text — and different networks
// phrase it differently: MTN uses "N1500 6GB - 7 days", 9mobile uses "...- 1000 Naira"
// (spelled out, no N prefix). Both patterns get stripped, then leftover " - -" / stray
// dashes from the removal are cleaned up so only OUR price is ever visible.
function cleanPlanName(name) {
  if (!name) return name;
  let cleaned = name
    .replace(/\bN[\d,]+(\.\d+)?\b/gi, '')
    .replace(/\b[\d,]+(\.\d+)?\s*Naira\b/gi, '');
  cleaned = cleaned.replace(/-\s*-/g, '-').replace(/\s{2,}/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '').trim();
  return cleaned;
}

// ---------- Overview ----------
async function loadOverview() {
  try {
    const wallet = await API.get('/wallet');
    document.getElementById('stat-balance').textContent = `₦${formatNaira(wallet.balance)}`;

    const orders = await API.get('/plans/orders');
    const pending = orders.filter((o) => o.status === 'pending').length;
    document.getElementById('stat-active-orders').textContent = pending;
    document.getElementById('stat-total-orders').textContent = orders.length;

    const body = document.getElementById('overview-orders-body');
    const empty = document.getElementById('overview-empty');
    if (orders.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      body.innerHTML = orders.slice(0, 5).map((o) => `
        <tr>
          <td>${o.network_name}</td>
          <td>${o.data_size || cleanPlanName(o.raw_name)}</td>
          <td>${o.phone_number}</td>
          <td>${statusBadge(o.status)}</td>
          <td>${timeAgo(o.created_at)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Fund wallet ----------
document.getElementById('fund-submit').addEventListener('click', async () => {
  const btn = document.getElementById('fund-submit');
  const amount = Number(document.getElementById('fund-amount').value);

  if (!amount || amount < 1000) {
    toast('Enter an amount of at least ₦1,000.', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Redirecting...';
  try {
    const data = await API.post('/wallet/fund', { amount });
    // Store the reference so payment-callback.html knows what to verify on return.
    sessionStorage.setItem('dataplug_pending_reference', data.reference);
    location.href = data.authorization_url;
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Continue to Paystack';
  }
});

// ---------- Buy data: networks -> duration tabs + plans -> purchase ----------
let plansCache = [];
let plansLoaded = false;
let plansState = { screen: 'networks', network: null, duration: 'weekly' };

const NETWORK_COLORS = {
  MTN: { bg: '#FFCC00', fg: '#111111' },
  Glo: { bg: '#00A651', fg: '#ffffff' },
  Airtel: { bg: '#ED1C24', fg: '#ffffff' },
  '9mobile': { bg: '#00A99D', fg: '#ffffff' },
};

async function loadPlans(force = false) {
  if (plansLoaded && !force) return;
  try {
    plansCache = await API.get('/plans');
    plansLoaded = true;
    goToPlansScreen('networks');
  } catch (err) {
    toast(err.message, true);
  }
}

function goToPlansScreen(screen, network) {
  plansState = { ...plansState, screen, network: network ?? plansState.network };

  document.getElementById('plans-screen-networks').style.display = screen === 'networks' ? 'block' : 'none';
  document.getElementById('plans-screen-plans').style.display = screen === 'plans' ? 'block' : 'none';
  document.getElementById('plans-screen-purchase').style.display = screen === 'purchase' ? 'block' : 'none';

  const breadcrumb = document.getElementById('plans-breadcrumb');
  const breadcrumbTitle = document.getElementById('plans-breadcrumb-title');

  if (screen === 'networks') {
    breadcrumb.style.display = 'none';
    renderNetworks();
  } else if (screen === 'plans') {
    breadcrumb.style.display = 'flex';
    breadcrumbTitle.textContent = plansState.network;
    document.getElementById('plans-back-btn').textContent = '← Back to networks';
    renderPlanCards();
  } else if (screen === 'purchase') {
    breadcrumb.style.display = 'flex';
    breadcrumbTitle.textContent = 'Confirm order';
    document.getElementById('plans-back-btn').textContent = '← Back to plans';
  }
}

document.getElementById('plans-back-btn').addEventListener('click', () => {
  if (plansState.screen === 'purchase') goToPlansScreen('plans');
  else if (plansState.screen === 'plans') goToPlansScreen('networks');
});

document.querySelectorAll('#plans-duration-tabs .order-type-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#plans-duration-tabs .order-type-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    plansState.duration = tab.dataset.duration;
    renderPlanCards();
  });
});

// ---------- Screen 1: networks ----------
function renderNetworks() {
  const grid = document.getElementById('plans-network-grid');
  const names = [...new Set(plansCache.map((p) => p.network_name))];
  const ORDER = ['MTN', 'Glo', 'Airtel', '9mobile'];
  const sorted = ORDER.filter((n) => names.includes(n));

  grid.innerHTML = sorted.map((name) => {
    const color = NETWORK_COLORS[name] || { bg: '#7C4DFF', fg: '#fff' };
    const count = plansCache.filter((p) => p.network_name === name).length;
    return `
      <div class="market-category-card" data-network="${name}">
        <div class="market-photo" style="background:${color.bg};display:flex;align-items:center;justify-content:center;">
          <span style="color:${color.fg};font-family:var(--font-display);font-weight:800;font-size:22px;letter-spacing:0.02em;">${name}</span>
        </div>
        <div class="market-category-body">
          <h3 class="market-category-name">${name}</h3>
          <p class="market-category-count">${count} plan${count === 1 ? '' : 's'}</p>
        </div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.market-category-card').forEach((card) => {
    card.addEventListener('click', () => goToPlansScreen('plans', card.dataset.network));
  });
}

// ---------- Screen 2: plans for the chosen network + duration ----------
function renderPlanCards() {
  const grid = document.getElementById('plans-cards');
  const empty = document.getElementById('plans-empty');
  const filtered = plansCache.filter((p) => p.network_name === plansState.network && p.duration === plansState.duration);

  if (filtered.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map((p) => `
    <div class="market-product-card" data-id="${p.id}">
      <div class="market-product-body">
        <h3 class="market-product-name">${p.data_size || cleanPlanName(p.raw_name)}</h3>
        <p class="market-product-desc">${cleanPlanName(p.raw_name)}</p>
        <div class="market-product-footer">
          <span class="market-product-price">₦${Number(p.price).toFixed(2)}</span>
        </div>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.market-product-card').forEach((card) => {
    card.addEventListener('click', () => openPurchaseScreen(Number(card.dataset.id)));
  });
}

// ---------- Screen 3: phone number + confirm / receipt ----------
function openPurchaseScreen(planId) {
  const plan = plansCache.find((p) => p.id === planId);
  if (!plan) return;

  document.getElementById('plans-purchase-content').innerHTML = `
    <div class="market-purchase-card">
      <div class="market-purchase-body">
        <h2 class="market-purchase-name">${plan.data_size || cleanPlanName(plan.raw_name)} — ${plan.network_name}</h2>
        <p class="market-purchase-meta">${cleanPlanName(plan.raw_name)}</p>
        <div class="form-grid">
          <p class="rate-note">Price: <span class="num">₦${Number(plan.price).toFixed(2)}</span></p>
          <div class="field">
            <label for="purchase-phone">Phone number to receive the data</label>
            <input id="purchase-phone" type="tel" placeholder="0801 234 5678" maxlength="11">
          </div>
          <button class="btn-primary" id="purchase-confirm">Confirm purchase</button>
        </div>
      </div>
    </div>
  `;
  goToPlansScreen('purchase');

  document.getElementById('purchase-confirm').addEventListener('click', () => confirmPurchase(plan));
}

async function confirmPurchase(plan) {
  const btn = document.getElementById('purchase-confirm');
  const phoneInput = document.getElementById('purchase-phone');
  const phoneNumber = phoneInput.value.trim();

  if (!/^0\d{10}$/.test(phoneNumber)) {
    toast('Enter a valid 11-digit number starting with 0.', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';
  try {
    const order = await API.post('/plans', { planId: plan.id, phoneNumber });
    renderPurchaseReceipt(plan, order, phoneNumber);
    loadOverview();
  } catch (err) {
    renderPurchaseError(plan, err.message);
  }
}

function renderPurchaseReceipt(plan, order, phoneNumber) {
  const isComplete = order.status === 'completed';
  document.getElementById('plans-purchase-content').innerHTML = `
    <div class="market-purchase-card">
      <div class="market-purchase-body">
        <h2 class="market-purchase-name">${isComplete ? 'Data delivered' : 'Order received'}</h2>
        <div class="modal-status ${isComplete ? 'success' : ''}" style="margin-top:10px;">
          ${isComplete ? '✓' : '⏳'} ${plan.data_size || cleanPlanName(plan.raw_name)} to ${phoneNumber} — ₦${Number(plan.price).toFixed(2)}
        </div>
        ${!isComplete ? '<p class="rate-note" style="margin-top:8px;">Confirming with the network — this updates automatically within a few minutes. Check Order history for the final status.</p>' : ''}
        <button class="btn-primary" id="purchase-done" style="margin-top:16px;">Done</button>
      </div>
    </div>
  `;
  document.getElementById('purchase-done').addEventListener('click', () => {
    goToPlansScreen('networks');
    if (document.getElementById('view-orders').classList.contains('active')) loadOrders();
  });
  toast(isComplete ? 'Purchase complete.' : 'Order received — confirming with the network.');
}

function renderPurchaseError(plan, message) {
  document.getElementById('plans-purchase-content').innerHTML = `
    <div class="market-purchase-card">
      <div class="market-purchase-body">
        <h2 class="market-purchase-name">Purchase failed</h2>
        <div class="modal-status error" style="margin-top:10px;">✕ ${message}</div>
        <button class="btn-primary" id="purchase-retry" style="margin-top:16px;">Back to plan</button>
      </div>
    </div>
  `;
  document.getElementById('purchase-retry').addEventListener('click', () => openPurchaseScreen(plan.id));
  toast(message, true);
}

// ---------- Order history ----------
async function loadOrders() {
  try {
    const orders = await API.get('/plans/orders');
    const body = document.getElementById('orders-body');
    const empty = document.getElementById('orders-empty');

    if (orders.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    body.innerHTML = orders.map((o) => `
      <tr>
        <td>${o.network_name}</td>
        <td>${o.data_size || cleanPlanName(o.raw_name)}</td>
        <td>${o.phone_number}</td>
        <td class="num">₦${formatNaira(o.charge)}</td>
        <td>${statusBadge(o.status)}</td>
        <td>${timeAgo(o.created_at)}</td>
      </tr>
    `).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Referrals ----------
async function loadReferrals() {
  const link = `${location.origin}/login.html?ref=${user.referral_code || ''}`;
  document.getElementById('referral-link').value = link;

  try {
    const data = await API.get('/wallet/referrals');
    document.getElementById('referral-total-count').textContent = data.referrals.length;
    document.getElementById('referral-rewarded-count').textContent = data.referrals.filter((r) => r.status === 'rewarded').length;
    document.getElementById('referral-total-earned').textContent = `₦${formatNaira(data.totalEarned)}`;

    const body = document.getElementById('referrals-list-body');
    const empty = document.getElementById('referrals-empty');
    if (data.referrals.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      body.innerHTML = data.referrals.map((r) => `
        <tr>
          <td>@${r.referred_username}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${timeAgo(r.created_at)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('copy-referral-link').addEventListener('click', () => {
  const input = document.getElementById('referral-link');
  input.select();
  navigator.clipboard?.writeText(input.value).then(() => toast('Referral link copied.')).catch(() => {
    document.execCommand('copy');
    toast('Referral link copied.');
  });
});

// ---------- Transactions ----------
async function loadTransactions() {
  try {
    const txs = await API.get('/wallet/transactions?limit=100');
    const body = document.getElementById('transactions-body');
    const empty = document.getElementById('transactions-empty');

    if (txs.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    body.innerHTML = txs.map((t) => `
      <tr>
        <td style="text-transform:capitalize;">${t.type.replace('_', ' ')}</td>
        <td class="num">₦${formatNaira(t.amount)}</td>
        <td class="num">₦${formatNaira(t.balance_after)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${timeAgo(t.created_at)}</td>
      </tr>
    `).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Recover a stuck payment ----------
// Runs on every dashboard load. Doesn't depend on sessionStorage or a Paystack redirect
// param surviving — those can vanish if the phone reloads the tab/app under memory
// pressure while the user is on Paystack's page. This just asks the server "do I have
// an unresolved funding attempt?" and re-verifies it directly against Paystack.
async function checkPendingPayment() {
  try {
    const { pending } = await API.get('/wallet/pending');
    if (!pending) return;

    toast('Confirming a previous payment...');
    const result = await API.get(`/wallet/verify/${pending.reference}`);
    if (result.status === 'success') {
      toast('Payment confirmed — your wallet has been credited.');
      loadOverview();
    }
    // If still not successful, leave it — the server-side reconciliation sweep will
    // keep retrying this reference on its own; no need to loop-poll from the client.
  } catch (err) {
    // Non-fatal — don't block the dashboard over a reconciliation check.
    console.warn('Pending payment check failed:', err.message);
  }
}

// ---------- Init ----------
loadOverview();
checkPendingPayment();
