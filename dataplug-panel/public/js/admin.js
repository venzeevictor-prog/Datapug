// ---------- Guard: must be logged in and staff ----------
if (!API.token()) location.href = '/login.html';

const user = API.currentUser();
const STAFF_ROLES = ['support', 'admin', 'super_admin'];
if (!user || !STAFF_ROLES.includes(user.role)) {
  location.href = '/dashboard.html';
}

document.getElementById('sidebar-username').textContent = user ? `@${user.username} (${user.role})` : '';

document.getElementById('logout-btn').addEventListener('click', () => {
  API.clearToken();
  location.href = '/login.html';
});

// Client-side permission mirror — purely for hiding nav the user has no access to.
// The server enforces the real boundary; this just avoids showing dead ends.
const PERMS = {
  support: ['support.respond', 'support.close'],
  admin: ['users.suspend', 'orders.refund_any', 'transactions.adjust', 'services.manage', 'provider.view_balance', 'audit.view', 'analytics.view', 'webstats.view', 'support.respond', 'support.close'],
  super_admin: ['users.suspend', 'users.manage_roles', 'orders.refund_any', 'transactions.adjust', 'services.manage', 'provider.view_balance', 'audit.view', 'analytics.view', 'webstats.view', 'costs.view_exact', 'support.respond', 'support.close'],
};
function can(perm) {
  return (PERMS[user?.role] || []).includes(perm);
}

if (!can('services.manage')) document.getElementById('nav-plans').style.display = 'none';
if (!can('services.manage')) document.getElementById('nav-providers').style.display = 'none';
if (!can('analytics.view')) document.getElementById('nav-analytics').style.display = 'none';
if (!can('webstats.view')) document.getElementById('nav-webstats').style.display = 'none';
if (!can('costs.view_exact')) {
  document.getElementById('plans-cost-header').style.display = 'none';
  document.getElementById('analytics-cost-header').style.display = 'none';
  document.getElementById('analytics-alltime-cost-card').style.display = 'none';
  document.getElementById('analytics-30d-cost-card').style.display = 'none';
}
if (!can('audit.view')) document.getElementById('nav-audit').style.display = 'none';
if (!can('users.manage_roles')) document.getElementById('role-change-card').style.display = 'none';

// ---------- Nav ----------
const navItems = document.querySelectorAll('.nav-item[data-view]');
const views = document.querySelectorAll('.view');

function showView(name) {
  navItems.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  views.forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
}

const mobileNavToggle = document.getElementById('nav-toggle');

navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.view);
    if (mobileNavToggle) mobileNavToggle.checked = false; // close the mobile drawer after picking a view
    if (btn.dataset.view === 'users') loadUsers();
    if (btn.dataset.view === 'orders') loadAdminOrders();
    if (btn.dataset.view === 'plans') loadPlansAdmin();
    if (btn.dataset.view === 'providers') loadProviders();
    if (btn.dataset.view === 'referrals') loadReferrals();
    if (btn.dataset.view === 'analytics') { loadAnalytics(); loadStatsChart(); }
    if (btn.dataset.view === 'webstats') loadWebstats();
    if (btn.dataset.view === 'support') loadSupportInbox();
    if (btn.dataset.view === 'audit') loadAuditLog();
  });
});

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${isError ? 'error' : ''}`;
  setTimeout(() => el.classList.remove('show'), 3200);
}

function statusBadge(status) {
  const clean = (status || 'pending').toLowerCase().replace(/\s+/g, '_');
  return `<span class="badge ${clean}">${clean.replace('_', ' ')}</span>`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ============ Users ============
let usersCache = [];

async function loadUsers() {
  try {
    const search = document.getElementById('users-search').value.trim();
    usersCache = await API.get(`/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`);
    const body = document.getElementById('users-body');
    body.innerHTML = usersCache.map((u) => `
      <tr>
        <td><strong>@${u.username}</strong><br><span style="color:var(--ink-soft);font-size:12px;">${u.email}</span></td>
        <td>${statusBadge(u.role)}</td>
        <td class="num">₦${formatNaira(u.balance || 0)}</td>
        <td>${u.is_active ? '<span class="badge in_progress">Active</span>' : '<span class="badge failed">Suspended</span>'}</td>
        <td>${formatDate(u.created_at)}</td>
        <td><button class="action-link" data-id="${u.id}" data-action="view">View</button></td>
      </tr>
    `).join('');
    body.querySelectorAll('[data-action="view"]').forEach((b) =>
      b.addEventListener('click', () => openUserDetail(b.dataset.id))
    );
  } catch (err) {
    toast(err.message, true);
  }
}

let searchDebounce;
document.getElementById('users-search').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadUsers, 300);
});

let currentDetailUserId = null;

async function openUserDetail(id) {
  try {
    const detail = await API.get(`/admin/users/${id}`);
    currentDetailUserId = id;

    document.getElementById('detail-username').textContent = `@${detail.username}`;
    document.getElementById('detail-email').textContent = detail.email;
    document.getElementById('detail-balance').textContent = `₦${formatNaira(detail.balance || 0)}`;
    document.getElementById('detail-role').innerHTML = statusBadge(detail.role);
    document.getElementById('detail-status').textContent = detail.is_active ? 'Active' : 'Suspended';
    document.getElementById('role-select').value = detail.role;

    const toggleBtn = document.getElementById('toggle-status-btn');
    toggleBtn.textContent = detail.is_active ? 'Suspend account' : 'Reactivate account';
    toggleBtn.onclick = () => toggleUserStatus(id, !detail.is_active);

    document.getElementById('detail-orders-body').innerHTML = detail.orders.map((o) => `
      <tr>
        <td>${o.plan_name}</td>
        <td class="num">${o.phone_number}</td>
        <td class="num">₦${formatNaira(o.charge)}</td>
        <td>${statusBadge(o.status)}</td>
        <td>${formatDate(o.created_at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" style="color:var(--ink-soft);">No orders yet.</td></tr>';

    document.getElementById('detail-transactions-body').innerHTML = detail.transactions.map((t) => `
      <tr>
        <td style="text-transform:capitalize;">${t.type.replace('_', ' ')}</td>
        <td class="num">₦${formatNaira(t.amount)}</td>
        <td class="num">₦${formatNaira(t.balance_after)}</td>
        <td>${formatDate(t.created_at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" style="color:var(--ink-soft);">No transactions yet.</td></tr>';

    views.forEach((v) => v.classList.remove('active'));
    document.getElementById('view-user-detail').classList.add('active');
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('back-to-users').addEventListener('click', () => showView('users'));

async function toggleUserStatus(id, newStatus) {
  if (!can('users.suspend')) { toast('You do not have permission to do this.', true); return; }
  try {
    await API.request(`/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: newStatus }) });
    toast(newStatus ? 'Account reactivated.' : 'Account suspended.');
    openUserDetail(id);
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('adjust-submit').addEventListener('click', async () => {
  const amountNaira = Number(document.getElementById('adjust-amount').value);
  const reason = document.getElementById('adjust-reason').value.trim();
  if (!amountNaira) { toast('Enter a non-zero amount.', true); return; }
  if (!reason) { toast('A reason is required.', true); return; }

  try {
    await API.post(`/admin/users/${currentDetailUserId}/wallet-adjust`, { amountNaira, reason });
    toast('Wallet adjusted.');
    document.getElementById('adjust-amount').value = '';
    document.getElementById('adjust-reason').value = '';
    openUserDetail(currentDetailUserId);
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('role-submit').addEventListener('click', async () => {
  const role = document.getElementById('role-select').value;
  try {
    await API.request(`/admin/users/${currentDetailUserId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    toast('Role updated.');
    openUserDetail(currentDetailUserId);
  } catch (err) {
    toast(err.message, true);
  }
});

// ============ Orders ============
async function loadAdminOrders() {
  try {
    const status = document.getElementById('orders-status-filter').value;
    const orders = await API.get(`/admin/orders${status ? `?status=${status}` : ''}`);
    const body = document.getElementById('admin-orders-body');
    const refundable = (s) => s !== 'failed';

    body.innerHTML = orders.map((o) => `
      <tr>
        <td>@${o.username}</td>
        <td>${o.network_name}</td>
        <td>${o.plan_name}</td>
        <td class="num">${o.phone_number}</td>
        <td class="num">₦${formatNaira(o.charge)}</td>
        <td>${statusBadge(o.status)}</td>
        <td>${formatDate(o.created_at)}</td>
        <td>${can('orders.refund_any') && refundable(o.status) ? `<button class="action-link danger" data-id="${o.id}" data-action="refund">Refund</button>` : '—'}</td>
      </tr>
    `).join('');

    body.querySelectorAll('[data-action="refund"]').forEach((b) =>
      b.addEventListener('click', () => refundOrderAdmin(b.dataset.id))
    );
  } catch (err) {
    toast(err.message, true);
  }
}
document.getElementById('orders-status-filter').addEventListener('change', loadAdminOrders);

async function refundOrderAdmin(id) {
  const reason = prompt('Reason for this refund (required, logged to audit trail):');
  if (!reason || !reason.trim()) return;
  try {
    await API.post(`/admin/orders/${id}/refund`, { reason: reason.trim() });
    toast('Order refunded.');
    loadAdminOrders();
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Data Plans ============
let plansAdminCache = [];

async function loadPlansAdmin() {
  try {
    plansAdminCache = await API.get('/plans/all');
    renderPlansAdmin();

    const providers = await API.get('/providers');
    const select = document.getElementById('sync-plans-provider-select');
    select.innerHTML = providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')
      || '<option value="">No providers yet — add one on the Providers tab</option>';
  } catch (err) {
    toast(err.message, true);
  }
}

function renderPlansAdmin() {
  const networkFilter = document.getElementById('plans-network-filter').value;
  const durationFilter = document.getElementById('plans-duration-filter').value;
  const filtered = plansAdminCache.filter((p) =>
    (!networkFilter || p.network_name === networkFilter) && (!durationFilter || p.duration === durationFilter)
  );

  const durationLabel = { weekly: 'Weekly', monthly: 'Monthly', '2-3months': '2-3 months', other: 'Other' };
  const networksCount = new Set(plansAdminCache.map((p) => p.network_name)).size;
  document.getElementById('plans-summary').textContent =
    `${plansAdminCache.length} plans across ${networksCount} networks` +
    (networkFilter || durationFilter ? ` · showing ${filtered.length} matching your filters` : '');

  const body = document.getElementById('plans-body');
  body.innerHTML = filtered.map((p) => `
    <tr data-plan-id="${p.id}">
      <td>${p.raw_name}</td>
      <td>${p.network_name}</td>
      <td>${durationLabel[p.duration] || p.duration}</td>
      <td>${p.data_size || '—'}</td>
      <td class="num">
        <input type="number" step="0.01" value="${Number(p.price).toFixed(2)}" class="price-input" style="width:90px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font-family:var(--font-mono);">
      </td>
      ${p.provider_price !== undefined ? `<td class="num">₦${Number(p.provider_price).toFixed(2)}</td>` : ''}
      <td class="num" style="color:${Number(p.margin_percent) < 10 ? 'var(--red)' : 'var(--signal)'};">${Number(p.margin_percent).toFixed(1)}%</td>
      <td>${p.is_active ? '<span class="badge in_progress">Active</span>' : '<span class="badge failed">Hidden</span>'}</td>
      <td>
        <button class="action-link" data-action="save-price">Save price</button>
        <button class="action-link ${p.is_active ? 'danger' : ''}" data-action="toggle">${p.is_active ? 'Hide' : 'Show'}</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="9" style="color:var(--ink-soft);">No plans match your filters.</td></tr>';

  body.querySelectorAll('[data-action="save-price"]').forEach((b) =>
    b.addEventListener('click', (e) => savePlanPrice(e.target.closest('tr')))
  );
  body.querySelectorAll('[data-action="toggle"]').forEach((b) =>
    b.addEventListener('click', (e) => togglePlan(e.target.closest('tr'), filtered))
  );
}

document.getElementById('plans-network-filter').addEventListener('change', renderPlansAdmin);
document.getElementById('plans-duration-filter').addEventListener('change', renderPlansAdmin);

async function savePlanPrice(row) {
  const id = row.dataset.planId;
  const price = Number(row.querySelector('.price-input').value);
  if (!price || price <= 0) { toast('Enter a valid price.', true); return; }
  try {
    await API.request(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify({ price }) });
    toast('Price updated.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function togglePlan(row, list) {
  const id = row.dataset.planId;
  const p = list.find((x) => String(x.id) === id);
  try {
    await API.request(`/plans/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !p.is_active }) });
    toast(p.is_active ? 'Plan hidden from customers.' : 'Plan now visible to customers.');
    loadPlansAdmin();
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('sync-plans-btn').addEventListener('click', async () => {
  const providerId = document.getElementById('sync-plans-provider-select').value;
  if (!providerId) { toast('Add a provider first.', true); return; }

  const btn = document.getElementById('sync-plans-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing (this can take a moment — 4 networks)...';
  try {
    const result = await API.post(`/plans/sync/${providerId}`);
    toast(result.message);
    loadPlansAdmin();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync from VTPass';
  }
});

// ============ Providers ============
async function loadProviders() {
  try {
    const providers = await API.get('/providers');
    const body = document.getElementById('providers-body');
    body.innerHTML = providers.map((p) => `
      <tr data-provider-id="${p.id}">
        <td><strong>${p.name}</strong><br><span style="color:var(--ink-soft);font-size:12px;">${p.slug}</span></td>
        <td class="num">${p.plan_count}</td>
        <td class="num">${Number(p.markup_multiplier).toFixed(2)}×</td>
        <td>${p.is_active ? '<span class="badge in_progress">Active</span>' : '<span class="badge failed">Disabled</span>'}</td>
        <td class="num balance-cell">—</td>
        <td>
          <button class="action-link" data-action="balance">Check balance</button>
          <button class="action-link ${p.is_active ? 'danger' : ''}" data-action="toggle">${p.is_active ? 'Disable' : 'Enable'}</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="color:var(--ink-soft);">No providers yet. Add one above.</td></tr>';

    body.querySelectorAll('[data-action="balance"]').forEach((b) =>
      b.addEventListener('click', (e) => checkProviderBalance(e.target.closest('tr')))
    );
    body.querySelectorAll('[data-action="toggle"]').forEach((b) =>
      b.addEventListener('click', (e) => toggleProvider(e.target.closest('tr'), providers))
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function checkProviderBalance(row) {
  const id = row.dataset.providerId;
  const cell = row.querySelector('.balance-cell');
  cell.textContent = '...';
  try {
    const data = await API.get(`/providers/${id}/balance`);
    cell.textContent = data.balance != null ? `₦${Number(data.balance).toLocaleString()}` : '—';
  } catch (err) {
    cell.textContent = 'Error';
    toast(err.message, true);
  }
}

async function toggleProvider(row, providers) {
  const id = row.dataset.providerId;
  const p = providers.find((x) => String(x.id) === id);
  try {
    await API.request(`/providers/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !p.is_active }) });
    toast(p.is_active ? 'Provider disabled.' : 'Provider enabled.');
    loadProviders();
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('add-provider-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-provider-name').value.trim();
  const slug = document.getElementById('new-provider-slug').value.trim();
  const api_url = document.getElementById('new-provider-url').value.trim();
  const api_key = document.getElementById('new-provider-key').value.trim();
  const secret_key = document.getElementById('new-provider-secret-key').value.trim();
  const public_key = document.getElementById('new-provider-public-key').value.trim();
  const markup_multiplier = Number(document.getElementById('new-provider-markup').value) || 1.15;

  if (!name || !slug || !api_url || !api_key || !secret_key || !public_key) {
    toast('All fields are required — VTPass needs all three keys.', true);
    return;
  }

  const btn = document.getElementById('add-provider-btn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    await API.post('/providers', { name, slug, api_url, api_key, secret_key, public_key, markup_multiplier });
    toast('Provider added. Sync its plans from the Data Plans tab.');
    ['new-provider-name', 'new-provider-slug', 'new-provider-key', 'new-provider-secret-key', 'new-provider-public-key'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('new-provider-markup').value = '1.15';
    loadProviders();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add provider';
  }
});

// ============ Referrals ============
async function loadReferrals() {
  try {
    const data = await API.get('/admin/referrals');
    document.getElementById('referrals-rewarded-count').textContent = data.summary.rewarded_count;
    document.getElementById('referrals-pending-count').textContent = data.summary.pending_count;
    document.getElementById('referrals-total-paid').textContent = `₦${formatNaira(data.summary.total_paid_out)}`;

    document.getElementById('referrals-body').innerHTML = data.referrals.map((r) => `
      <tr>
        <td>@${r.referrer_username}</td>
        <td>@${r.referred_username}</td>
        <td class="num">₦${formatNaira(r.reward_amount)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${formatDate(r.created_at)}</td>
        <td>${r.rewarded_at ? formatDate(r.rewarded_at) : '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="color:var(--ink-soft);">No referrals yet.</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Support inbox ============
let activeConvoId = null;
let inboxPollInterval = null;
let messagePollInterval = null;

async function loadSupportInbox() {
  await refreshConvoList();
  if (inboxPollInterval) clearInterval(inboxPollInterval);
  inboxPollInterval = setInterval(refreshConvoList, 8000);
}

async function refreshConvoList() {
  try {
    const convos = await API.get('/support/conversations');
    const list = document.getElementById('admin-chat-list');
    list.innerHTML = convos.map((c) => `
      <div class="chat-list-item ${c.id === activeConvoId ? 'active' : ''}" data-id="${c.id}">
        <div class="meta">
          <span class="name">@${c.username}</span>
          ${statusBadge(c.status)}
        </div>
        <div class="preview">${c.subject || 'No subject'} · ${new Date(c.last_message_at).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    `).join('') || '<div style="padding:20px;color:var(--ink-soft);font-size:13px;">No conversations yet.</div>';

    list.querySelectorAll('.chat-list-item').forEach((el) =>
      el.addEventListener('click', () => openConvo(el.dataset.id, convos))
    );
  } catch (err) {
    toast(err.message, true);
  }
}

async function openConvo(id, convos) {
  activeConvoId = id;
  refreshConvoList();

  const convo = convos.find((c) => String(c.id) === String(id));
  document.getElementById('admin-chat-title').textContent = convo ? `@${convo.username}` : 'Conversation';

  const closeBtn = document.getElementById('admin-close-convo-btn');
  const input = document.getElementById('admin-chat-input');
  const sendBtn = document.getElementById('admin-chat-send-btn');

  const isClosed = convo?.status === 'closed';
  input.disabled = isClosed;
  sendBtn.disabled = isClosed;
  closeBtn.style.display = can('support.close') && !isClosed ? 'inline-block' : 'none';
  closeBtn.onclick = () => closeConvo(id);

  await loadConvoMessages(id);

  if (messagePollInterval) clearInterval(messagePollInterval);
  messagePollInterval = setInterval(() => loadConvoMessages(id), 4000);
}

async function loadConvoMessages(id) {
  try {
    const messages = await API.get(`/support/conversations/${id}/messages`);
    const container = document.getElementById('admin-chat-messages');
    container.innerHTML = messages.map((m) => {
      const mine = m.sender_id === user.id;
      const time = new Date(m.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="chat-bubble ${mine ? 'mine' : 'theirs'}">
          ${m.body.replace(/</g, '&lt;')}
          <div class="meta">${mine ? 'You' : m.sender_username} · ${time}</div>
        </div>
      `;
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch (err) { /* silent on poll failures */ }
}

document.getElementById('admin-chat-send-btn').addEventListener('click', sendAdminChatMessage);
document.getElementById('admin-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendAdminChatMessage();
});

async function sendAdminChatMessage() {
  const input = document.getElementById('admin-chat-input');
  const text = input.value.trim();
  if (!text || !activeConvoId) return;
  try {
    await API.post(`/support/conversations/${activeConvoId}/messages`, { message: text });
    input.value = '';
    loadConvoMessages(activeConvoId);
  } catch (err) {
    toast(err.message, true);
  }
}

async function closeConvo(id) {
  if (!confirm('Close this conversation?')) return;
  try {
    await API.request(`/support/conversations/${id}/close`, { method: 'PATCH' });
    toast('Conversation closed.');
    refreshConvoList();
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Audit log ============
async function loadAuditLog() {
  try {
    const logs = await API.get('/admin/audit-log');
    document.getElementById('audit-body').innerHTML = logs.map((l) => `
      <tr>
        <td>@${l.actor_username || 'system'}</td>
        <td>${l.action}</td>
        <td>${l.target_type ? `${l.target_type} #${l.target_id}` : '—'}</td>
        <td style="font-size:12px;color:var(--ink-soft);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${JSON.stringify(l.details)}</td>
        <td>${formatDate(l.created_at)}</td>
      </tr>
    `).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Analytics (revenue / profit) ============
async function loadAnalytics() {
  try {
    const data = await API.get('/admin/analytics');

    document.getElementById('analytics-alltime-revenue').textContent = `₦${formatNaira(data.allTime.total_revenue)}`;
    document.getElementById('analytics-alltime-cost').textContent = `₦${formatNaira(data.allTime.total_cost)}`;
    document.getElementById('analytics-alltime-profit').textContent = `₦${formatNaira(data.allTime.total_profit)}`;

    document.getElementById('analytics-30d-revenue').textContent = `₦${formatNaira(data.last30Days.total_revenue)}`;
    document.getElementById('analytics-30d-cost').textContent = `₦${formatNaira(data.last30Days.total_cost)}`;
    document.getElementById('analytics-30d-profit').textContent = `₦${formatNaira(data.last30Days.total_profit)}`;

    const body = document.getElementById('analytics-by-network-body');
    body.innerHTML = data.byNetwork.map((n) => `
      <tr>
        <td>${n.network_name}</td>
        <td class="num">${n.order_count}</td>
        <td class="num">₦${formatNaira(n.revenue)}</td>
        ${n.cost !== undefined ? `<td class="num">₦${formatNaira(n.cost)}</td>` : ''}
        <td class="num" style="color:${Number(n.profit) < 0 ? 'var(--red)' : 'var(--signal)'};">₦${formatNaira(n.profit)}</td>
      </tr>
    `).join('') || `<tr><td colspan="${can('costs.view_exact') ? 5 : 4}" style="color:var(--ink-soft);">No completed orders yet.</td></tr>`;
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Stats over time (daily / monthly / custom range) ============
let statsChartInstance = null;

document.getElementById('stats-period-select').addEventListener('change', (e) => {
  const isRange = e.target.value === 'range';
  document.getElementById('stats-range-from').style.display = isRange ? 'inline-block' : 'none';
  document.getElementById('stats-range-to').style.display = isRange ? 'inline-block' : 'none';
  document.getElementById('stats-range-apply').style.display = isRange ? 'inline-block' : 'none';
  if (!isRange) loadStatsChart();
});
document.getElementById('stats-range-apply').addEventListener('click', loadStatsChart);

async function loadStatsChart() {
  const period = document.getElementById('stats-period-select').value;
  const canSeeCost = can('costs.view_exact');
  document.getElementById('stats-table-cost-header').textContent = canSeeCost ? 'Profit' : '';
  if (!canSeeCost) document.getElementById('stats-table-cost-header').style.display = 'none';

  try {
    let data, rows, labelKey, labelFormat;
    if (period === 'daily') {
      data = await API.get('/admin/analytics/daily?days=30');
      rows = data.orders; labelKey = 'day';
      labelFormat = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
    } else if (period === 'monthly') {
      data = await API.get('/admin/analytics/monthly?months=12');
      rows = data.orders; labelKey = 'month';
      labelFormat = (d) => new Date(d).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' });
    } else {
      const from = document.getElementById('stats-range-from').value;
      const to = document.getElementById('stats-range-to').value;
      if (!from || !to) { toast('Pick both a start and end date.', true); return; }
      data = await API.get(`/admin/analytics/range?from=${from}&to=${to}`);
      rows = data.orders; labelKey = 'day';
      labelFormat = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
    }

    const labels = rows.map((r) => labelFormat(r[labelKey]));
    const revenue = rows.map((r) => Number(r.revenue) / 100);
    const orderCounts = rows.map((r) => Number(r.order_count));

    if (statsChartInstance) statsChartInstance.destroy();
    const ctx = document.getElementById('stats-chart').getContext('2d');
    statsChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Revenue (₦)', data: revenue, backgroundColor: '#7C4DFF', yAxisID: 'y' },
          { label: 'Orders', data: orderCounts, type: 'line', borderColor: '#00C2A8', backgroundColor: '#00C2A8', yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: { position: 'left', title: { display: true, text: 'Revenue (₦)' } },
          y1: { position: 'right', title: { display: true, text: 'Orders' }, grid: { drawOnChartArea: false } },
        },
      },
    });

    document.getElementById('stats-table-body').innerHTML = rows.map((r) => `
      <tr>
        <td>${labelFormat(r[labelKey])}</td>
        <td class="num">${r.order_count}</td>
        <td class="num">₦${formatNaira(r.revenue)}</td>
        ${r.profit !== undefined ? `<td class="num">₦${formatNaira(r.profit)}</td>` : '<td></td>'}
      </tr>
    `).join('') || '<tr><td colspan="4" style="color:var(--ink-soft);">No orders in this period.</td></tr>';
  } catch (err) {
    toast(err.message, true);
  }
}

// ============ Website stats ============
function webstatsBarList(rows, labelKey, container, maxCount) {
  if (!rows.length) {
    container.innerHTML = `<p style="color:var(--ink-soft);font-size:13px;">No data yet.</p>`;
    return;
  }
  const max = maxCount || Math.max(...rows.map((r) => Number(r.count)));
  container.innerHTML = rows.map((r) => `
    <div class="webstats-bar-row">
      <span class="wb-label">${r[labelKey]}</span>
      <span class="wb-track"><span class="wb-fill" style="width:${max ? (Number(r.count) / max) * 100 : 0}%;"></span></span>
      <span class="wb-count">${Number(r.count).toLocaleString()}</span>
    </div>
  `).join('');
}

async function loadWebstats() {
  try {
    const data = await API.get('/admin/webstats');
    const t = data.totals;

    document.getElementById('webstats-total-views').textContent = Number(t.views).toLocaleString();
    document.getElementById('webstats-total-visitors').textContent = Number(t.unique_visitors).toLocaleString();
    document.getElementById('webstats-24h-views').textContent = Number(t.views_24h).toLocaleString();
    document.getElementById('webstats-24h-visitors').textContent = Number(t.unique_visitors_24h).toLocaleString();
    document.getElementById('webstats-30d-views').textContent = Number(t.views_30d).toLocaleString();
    document.getElementById('webstats-30d-visitors').textContent = Number(t.unique_visitors_30d).toLocaleString();

    const pagesEl = document.getElementById('webstats-pages');
    pagesEl.innerHTML = data.topPages.length
      ? data.topPages.map((p) => `
          <div class="webstats-bar-row">
            <span class="wb-label" style="width:auto;flex:1;font-family:var(--font-mono);font-size:12px;">${p.path}</span>
            <span class="wb-count">${Number(p.views).toLocaleString()}</span>
          </div>
        `).join('')
      : `<p style="color:var(--ink-soft);font-size:13px;">No data yet.</p>`;

    webstatsBarList(data.devices, 'device_type', document.getElementById('webstats-devices'));
    webstatsBarList(data.browsers, 'browser', document.getElementById('webstats-browsers'));
    webstatsBarList(data.operatingSystems, 'os', document.getElementById('webstats-os'));
    webstatsBarList(data.locations, 'country', document.getElementById('webstats-locations'));

    const recentBody = document.getElementById('webstats-recent-body');
    const recentEmpty = document.getElementById('webstats-recent-empty');
    if (data.recent.length === 0) {
      recentBody.innerHTML = '';
      recentEmpty.style.display = 'block';
    } else {
      recentEmpty.style.display = 'none';
      recentBody.innerHTML = data.recent.map((v) => {
        const location = [v.city, v.region, v.country].filter(Boolean).join(', ') || '—';
        const referrer = v.referrer ? v.referrer.replace(/^https?:\/\//, '').slice(0, 40) : '—';
        return `
          <tr>
            <td style="white-space:nowrap;">${formatDate(v.created_at)}</td>
            <td style="font-family:var(--font-mono);font-size:12px;">${v.path}</td>
            <td>${v.username ? `@${v.username}` : 'Guest'}</td>
            <td style="text-transform:capitalize;">${v.device_type || '—'}</td>
            <td>${v.browser || '—'} ${v.browser_version || ''}</td>
            <td>${v.os || '—'}</td>
            <td>${location}</td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${referrer}</td>
            <td style="font-family:var(--font-mono);font-size:12px;">${v.ip_address || '—'}</td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Init ----------
loadUsers();
