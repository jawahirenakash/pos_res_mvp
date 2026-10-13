let token = localStorage.getItem('tabletap_token') || '';
let me = null, boot = null, cart = new Map(), activeView = 'billing', pendingOrder = null, pendingCreds = null;

const $ = (id) => document.getElementById(id);
const fmt = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: boot?.restaurant?.currency || 'USD' }).format(Number(n || 0));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_LABEL = { OPEN: 'Open', SENT_TO_KITCHEN: 'New', PREPARING: 'Preparing', READY: 'Ready', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };

/* ---------------------------------------------------------------- theme */
const themeBtn = $('themeToggle');
function syncThemeBtn() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
themeBtn.onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('tabletap_theme', next); } catch (e) { /* ignore */ }
  syncThemeBtn();
};
syncThemeBtn();

/* ---------------------------------------------------------------- api */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch('/api' + path, { ...options, headers });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== '/auth/login') signOut();
    throw Error(d.error || 'Request failed');
  }
  return d;
}
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.add('hidden'), 2600);
}
/* Bars carry their target width in data-w and are painted via CSSOM: the strict
   style-src 'self' CSP blocks inline style="" attributes, but not CSSOM writes. */
function paintBars(scope) {
  (scope || document).querySelectorAll('[data-w]').forEach((b) => { b.style.width = b.dataset.w + '%'; });
}

/* --------------------------------------------------------------- screens */
function showLogin() {
  $('loginScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
}
function showApp() {
  $('loginScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('restaurantName').textContent = boot.restaurant.name;
}
function signOut() {
  token = '';
  localStorage.removeItem('tabletap_token');
  pendingCreds = null;
  $('changePwModal').classList.add('hidden');
  showLogin();
}

/* ----------------------------------------------------------------- auth */
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const f = new FormData(e.currentTarget);
    const pw = String(f.get('password'));
    const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: f.get('email'), password: pw }) });
    token = d.token;
    localStorage.setItem('tabletap_token', token);
    me = d.user;
    if (d.user.mustChangePassword) {
      pendingCreds = pw;
      $('newPassword').value = '';
      $('confirmPassword').value = '';
      $('changePwError').textContent = '';
      $('changePwModal').classList.remove('hidden');
      return;
    }
    await loadApp();
  } catch (x) { $('loginError').textContent = x.message; }
};

$('changePwForm').onsubmit = async (e) => {
  e.preventDefault();
  const np = $('newPassword').value, cp = $('confirmPassword').value;
  $('changePwError').textContent = '';
  if (np !== cp) { $('changePwError').textContent = 'The two passwords do not match.'; return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: pendingCreds, newPassword: np }) });
    $('changePwModal').classList.add('hidden');
    pendingCreds = null;
    toast('Password updated');
    await loadApp();
  } catch (x) { $('changePwError').textContent = x.message; }
};
$('logoutBtn').onclick = signOut;

/* ------------------------------------------------------------ app boot */
async function loadApp() {
  try {
    me = await api('/me');
    if (me.mustChangePassword) { signOut(); toast('Please sign in once more to set a new password.'); return; }
    boot = await api('/bootstrap');
    showApp();
    renderFilters();
    renderMenu();
    renderCart();
    switchView(activeView);
  } catch (e) { toast(e.message); }
}

function renderFilters() {
  $('categoryFilter').innerHTML = '<option value="all">All categories</option>' + boot.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('tableSelect').innerHTML = '<option value="">No table</option>' + boot.tables.map((t) => `<option value="${esc(t.label)}">${esc(t.label)}</option>`).join('');
  $('taxLabel').textContent = `(${(Number(boot.restaurant.taxRate) * 100).toFixed(2)}%)`;
}

function icon(n) {
  n = n.toLowerCase();
  if (n.includes('burger')) return '🍔';
  if (n.includes('pizza')) return '🍕';
  if (n.includes('chicken')) return '🍗';
  if (n.includes('fries')) return '🍟';
  if (n.includes('bread')) return '🥖';
  if (n.includes('brownie') || n.includes('chocolate')) return '🍫';
  if (n.includes('latte') || n.includes('coffee')) return '☕';
  if (n.includes('lemon')) return '🍋';
  return '🍽️';
}

function renderMenu() {
  if (!boot) return;
  const q = $('searchMenu').value.toLowerCase(), cat = $('categoryFilter').value;
  const items = boot.menuItems.filter((i) => (cat === 'all' || i.categoryId === cat) && (i.name + ' ' + (i.description || '')).toLowerCase().includes(q));
  $('menuGrid').innerHTML = items.map((i) => `<button class="menuitem" type="button" data-add="${i.id}"><span class="dishicon" aria-hidden="true">${icon(i.name)}</span><strong>${esc(i.name)}</strong><small>${esc(i.description || i.category?.name || 'Menu item')}</small><span class="price">${fmt(i.price)}</span></button>`).join('') || '<p class="hint">No matching menu items.</p>';
  document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
    const item = boot.menuItems.find((i) => i.id === b.dataset.add), old = cart.get(item.id);
    cart.set(item.id, { item, quantity: (old?.quantity || 0) + 1 });
    renderCart();
  });
}

function totals() {
  const subtotal = [...cart.values()].reduce((s, x) => s + Number(x.item.price) * x.quantity, 0);
  const pct = Math.max(0, Math.min(100, Number($('discountPct').value) || 0));
  const discount = Math.round(subtotal * pct) / 100;
  const tax = Math.round(Math.max(0, subtotal - discount) * Number(boot.restaurant.taxRate) * 100) / 100;
  return { subtotal, discount, tax, total: Math.round((subtotal - discount + tax) * 100) / 100 };
}

function renderCart() {
  if (!boot) return;
  const rows = [...cart.values()];
  $('cartItems').innerHTML = rows.length
    ? rows.map(({ item, quantity }) => `<div class="cartline"><div><strong>${esc(item.name)}</strong><small>${fmt(item.price)} each</small><div class="qty"><button type="button" data-qty="${item.id},-1" aria-label="Decrease">−</button><b>${quantity}</b><button type="button" data-qty="${item.id},1" aria-label="Increase">+</button><button type="button" class="remove" data-remove="${item.id}">Remove</button></div></div><div class="rightprice">${fmt(Number(item.price) * quantity)}</div></div>`).join('')
    : '<div class="empty"><span aria-hidden="true">🧾</span><b>Your bill starts here</b><small>Choose menu items.</small></div>';
  document.querySelectorAll('[data-qty]').forEach((b) => b.onclick = () => {
    const [id, d] = b.dataset.qty.split(','), x = cart.get(id);
    x.quantity += Number(d);
    if (x.quantity < 1) cart.delete(id);
    renderCart();
  });
  document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => { cart.delete(b.dataset.remove); renderCart(); });
  const t = totals();
  $('subtotal').textContent = fmt(t.subtotal);
  $('tax').textContent = fmt(t.tax);
  $('total').textContent = fmt(t.total);
  $('placeOrder').disabled = !rows.length;
}

$('searchMenu').oninput = renderMenu;
$('categoryFilter').onchange = renderMenu;
$('discountPct').oninput = renderCart;
$('clearCart').onclick = () => { cart.clear(); $('discountPct').value = 0; renderCart(); };

$('placeOrder').onclick = async () => {
  if (!cart.size) return;
  const btn = $('placeOrder');
  btn.disabled = true;
  try {
    const o = await api('/orders', { method: 'POST', body: JSON.stringify({ orderType: $('orderType').value, tableLabel: $('tableSelect').value || null, discountPercent: Number($('discountPct').value) || 0, tip: 0, items: [...cart.values()].map((x) => ({ menuItemId: x.item.id, quantity: x.quantity })) }) });
    pendingOrder = o;
    cart.clear();
    $('discountPct').value = 0;
    renderCart();
    $('paymentAmount').value = Number(o.total).toFixed(2);
    $('paymentError').textContent = '';
    $('paymentModal').classList.remove('hidden');
    toast(`Order #${o.orderNumber} sent to kitchen`);
  } catch (e) { toast(e.message); } finally { btn.disabled = !cart.size; }
};

$('closePayment').onclick = () => $('paymentModal').classList.add('hidden');
$('paymentForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!pendingOrder) return;
  try {
    const result = await api(`/orders/${pendingOrder.id}/payments`, { method: 'POST', body: JSON.stringify({ method: $('paymentMethod').value, amount: Number($('paymentAmount').value) }) });
    $('paymentModal').classList.add('hidden');
    toast(result.remaining > 0 ? `Payment recorded. Balance: ${fmt(result.remaining)}` : 'Payment recorded. Order completed.');
    pendingOrder = null;
    if (activeView === 'kitchen') loadKitchen();
  } catch (x) { $('paymentError').textContent = x.message; }
};

/* --------------------------------------------------------------- views */
function switchView(v) {
  activeView = v;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  ['billing', 'kitchen', 'inventory', 'reports'].forEach((x) => $(x + 'View').classList.toggle('hidden', x !== v));
  if (v === 'kitchen') loadKitchen();
  if (v === 'inventory') loadInventory();
  if (v === 'reports') loadReport();
}
document.querySelectorAll('.tab').forEach((b) => b.onclick = () => switchView(b.dataset.view));

async function loadKitchen() {
  try {
    const orders = await api('/kitchen');
    $('kitchenGrid').innerHTML = orders.map((o) => `<article class="ticket" data-status="${o.status}"><div class="tickettop"><h3>Order #${o.orderNumber}</h3><span class="chip" data-status="${o.status}">${STATUS_LABEL[o.status] || o.status}</span></div><small>${esc(o.orderType.replace('_', ' '))} · ${esc(o.tableLabel || 'No table')} · ${new Date(o.createdAt).toLocaleTimeString()}</small><ul>${o.items.map((i) => `<li><span class="q">${i.quantity}×</span><span>${esc(i.nameSnapshot)}</span></li>`).join('')}</ul><div class="sumrow"><span>Total</span><b>${fmt(o.total)}</b></div><div class="ticketactions">${o.status === 'SENT_TO_KITCHEN' ? `<button type="button" data-status="${o.id},PREPARING">Start prep</button>` : ''}${o.status === 'PREPARING' ? `<button type="button" data-status="${o.id},READY">Mark ready</button>` : ''}${o.status === 'READY' ? `<button type="button" data-status="${o.id},COMPLETED">Complete</button>` : ''}</div></article>`).join('') || '<div class="empty"><span aria-hidden="true">👨‍🍳</span><b>No active kitchen tickets</b><small>New orders appear here.</small></div>';
    document.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
      const [id, status] = b.dataset.status.split(',');
      try { await api(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); loadKitchen(); }
      catch (e) { toast(e.message); }
    });
  } catch (e) { toast(e.message); }
}
$('refreshKitchen').onclick = loadKitchen;

async function loadInventory() {
  try {
    const rows = await api('/inventory');
    $('inventoryList').innerHTML = rows.map((i) => {
      const qty = Number(i.quantity), low = Number(i.lowStockAt);
      const cap = Math.max(low * 4, qty, 1);
      const pct = Math.max(5, Math.min(100, Math.round((qty / cap) * 100)));
      const cls = i.lowStock ? 'danger' : (qty <= low * 1.25 ? 'warn' : '');
      return `<div class="stockrow"><div class="stockmeta"><div class="stockname"><b>${esc(i.name)}</b>${i.lowStock ? '<span class="low">Low stock</span>' : ''}</div><small>${qty} ${esc(i.unit)} on hand · reorder at ${low}</small><div class="bar"><div class="barfill ${cls}" data-w="${pct}"></div></div></div><div class="stockactions"><button type="button" data-stock="${i.id},PURCHASE">+ Purchase</button><button type="button" data-stock="${i.id},WASTE">– Waste</button></div></div>`;
    }).join('') || '<p class="hint">No ingredients found.</p>';
    paintBars($('inventoryList'));
    document.querySelectorAll('[data-stock]').forEach((b) => b.onclick = async () => {
      const [id, type] = b.dataset.stock.split(',');
      const n = Number(prompt(type === 'PURCHASE' ? 'Quantity purchased:' : 'Quantity wasted:'));
      if (!Number.isFinite(n) || n <= 0) return;
      try { await api(`/inventory/${id}/movement`, { method: 'POST', body: JSON.stringify({ type, quantity: n, reason: 'Recorded in POS' }) }); toast('Stock updated'); loadInventory(); }
      catch (e) { toast(e.message); }
    });
  } catch (e) { toast(e.message); }
}
$('refreshInventory').onclick = loadInventory;

async function loadReport() {
  try {
    const r = await api('/reports/daily');
    const avg = r.paidOrderCount ? r.paidAmount / r.paidOrderCount : 0;
    $('reportCards').innerHTML = `<div class="metric hero"><small>Payments recorded</small><b>${fmt(r.paidAmount)}</b><span class="metric-note">${r.paidOrderCount} paid order${r.paidOrderCount === 1 ? '' : 's'} · avg ${fmt(avg)}</span></div><div class="metric"><small>Orders today</small><b>${r.orderCount}</b><span class="metric-note">Non-cancelled tickets</span></div><div class="metric"><small>Paid orders</small><b>${r.paidOrderCount}</b><span class="metric-note">Settled tickets</span></div>`;
    const max = Math.max(1, ...r.topItems.map((i) => i.quantity));
    $('topItems').innerHTML = r.topItems.map((i) => {
      const pct = Math.round((i.quantity / max) * 100);
      return `<div class="datarow"><div class="stockmeta"><div class="stockname"><b>${esc(i.name)}</b></div><small>${i.quantity} sold</small><div class="bar"><div class="barfill" data-w="${pct}"></div></div></div><strong>${i.quantity}</strong></div>`;
    }).join('') || '<p class="hint">No sales yet.</p>';
    paintBars($('topItems'));
  } catch (e) { toast(e.message); }
}
$('refreshReport').onclick = loadReport;

if (token) loadApp();
else showLogin();
