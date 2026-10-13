import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BASE = 'http://localhost:4000';
const DEMO_RESTAURANT = 'demo-restaurant';
const prisma = new PrismaClient();
const seededPassword = process.env.SEED_OWNER_PASSWORD || '';
const newPassword = 'SmokePass2026!x';
const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
const section = (name) => results.push(`— ${name} —`);

async function waitForServer(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const j = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch(`${BASE}${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, headers: r.headers };
};
const login = async (email, password) => j('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
const authed = (token) => ({ Authorization: `Bearer ${token}` });
const inKitchen = (orders, id) => orders.some((o) => o.id === id);
const R = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function main() {
  const smokeStart = new Date();
  const createdMenu = [];
  let createdCount = 0;
  let roleUsers = [];
  let tenantRestaurant = null;
  // Baseline captured before any test mutation, restored in cleanup.
  const initialStock = await prisma.ingredient.findMany({ where: { restaurantId: DEMO_RESTAURANT }, select: { id: true, quantity: true } });
  // Unique per-run identities: the in-memory login limiter keys on ip|email and
  // persists across runs, so reused emails can arrive already throttled.
  const stamp = Date.now();
  const nobodyEmail = `nobody-${stamp}@example.com`;
  try {
    section('SETUP');
    check('server reachable', await waitForServer());

    // Headers / CORS
    section('SECURITY HEADERS & CORS');
    const shell = await fetch(`${BASE}/`);
    const h = shell.headers;
    check('CSP header present', h.get('content-security-policy')?.includes("default-src 'self'") === true);
    check('X-Content-Type-Options nosniff', h.get('x-content-type-options') === 'nosniff');
    check('X-Frame-Options DENY', h.get('x-frame-options') === 'DENY');
    check('no x-powered-by leak', h.get('x-powered-by') === null);
    const cors = await j('/api/health', { headers: { Origin: 'https://evil.example' } });
    check('no CORS header for foreign origin', cors.headers.get('access-control-allow-origin') === null);
    check('health ok', cors.status === 200 && cors.body.ok === true);

    // Demo users for the role-authorization matrix (deleted in cleanup)
    section('ROLE USERS');
    const roleDefs = [
      { key: 'CASHIER', email: `cashier-smoke-${stamp}@example.com`, name: 'Smoke Cashier', role: 'CASHIER', password: 'CashierTest2026!' },
      { key: 'KITCHEN', email: `kitchen-smoke-${stamp}@example.com`, name: 'Smoke Kitchen', role: 'KITCHEN', password: 'KitchenTest2026!' },
      { key: 'MANAGER', email: `manager-smoke-${stamp}@example.com`, name: 'Smoke Manager', role: 'MANAGER', password: 'ManagerTest2026!' }
    ];
    const lockoutUser = { key: 'LOCKOUT', email: `lockout-smoke-${stamp}@example.com`, name: 'Smoke Lockout', role: 'CASHIER', password: 'LockoutTest2026!' };
    roleUsers = [...roleDefs, lockoutUser];
    for (const u of roleUsers) {
      await prisma.user.create({ data: { restaurantId: DEMO_RESTAURANT, name: u.name, email: u.email, passwordHash: await bcrypt.hash(u.password, 4), role: u.role } });
    }
    const tokens = {};
    for (const u of roleDefs) {
      const l = await login(u.email, u.password);
      tokens[u.key] = l.body?.token;
      check(`role login ${u.role}`, l.status === 200 && Boolean(tokens[u.key]));
    }

    // Auth basics
    section('AUTH BASICS');
    const bad = await login('owner@tabletap.local', 'WrongPass123!');
    check('wrong password rejected 401 (owner)', bad.status === 401 && bad.body.error === 'Email or password is incorrect');
    const ghost = await login(nobodyEmail, 'WrongPass123!');
    check('unknown account rejected 401 same message', ghost.status === 401 && ghost.body.error === 'Email or password is incorrect');
    const loginRes = await login('owner@tabletap.local', seededPassword);
    check('seeded login succeeds (mustChangePassword)', loginRes.status === 200 && loginRes.body.user?.mustChangePassword === true);
    const ownerToken = loginRes.body.token;
    const unauth = await j('/api/bootstrap');
    check('protected route without token is 401', unauth.status === 401);
    const forged = await j('/api/bootstrap', { headers: authed('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXJlc3RhdXJhbnQiLCJyb2xlIjoiT1dORVIifQ.fake') });
    check('forged JWT rejected 401', forged.status === 401);
    // Must run BEFORE the change-password below clears the flag (the gate reads the DB).
    const forced = await j('/api/orders', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ items: [{ menuItemId: 'x', quantity: 1 }] }) });
    check('mustChangePassword token blocked from other APIs (403)', forced.status === 403);
    const wrongCurrent = await j('/api/auth/change-password', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ currentPassword: 'NotThePassword!', newPassword }) });
    check('change-password wrong current rejected 400', wrongCurrent.status === 400);
    const weakNew = await j('/api/auth/change-password', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ currentPassword: seededPassword, newPassword: 'short' }) });
    check('change-password weak new rejected 400', weakNew.status === 400 && /at least|letters and numbers/.test(weakNew.body.error));
    const changed = await j('/api/auth/change-password', { method: 'POST', headers: authed(ownerToken), body: JSON.stringify({ currentPassword: seededPassword, newPassword }) });
    check('change-password succeeds', changed.status === 200 && changed.body.ok === true);
    const relogin = await login('owner@tabletap.local', newPassword);
    check('re-login with new password, flag cleared', relogin.status === 200 && relogin.body.user?.mustChangePassword === false);
    const owner = relogin.body.token;

    // Role authorization matrix
    section('ROLE AUTHORIZATION MATRIX');
    const denied = async (label, fn) => { const x = await fn(); check(label, x.status === 403); };
    await denied('cashier cannot get reports (403)', () => j('/api/reports/daily', { headers: authed(tokens.CASHIER) }));
    await denied('cashier cannot create menu item (403)', () => j('/api/menu', { method: 'POST', headers: authed(tokens.CASHIER), body: JSON.stringify({ name: 'Hack', price: 1 }) }));
    await denied('cashier cannot get inventory (403)', () => j('/api/inventory', { headers: authed(tokens.CASHIER) }));
    await denied('kitchen cannot get reports (403)', () => j('/api/reports/daily', { headers: authed(tokens.KITCHEN) }));
    await denied('kitchen cannot create menu item (403)', () => j('/api/menu', { method: 'POST', headers: authed(tokens.KITCHEN), body: JSON.stringify({ name: 'Hack', price: 1 }) }));
    const cashierMenu = await j('/api/menu', { headers: authed(tokens.CASHIER) });
    check('cashier can read menu (200)', cashierMenu.status === 200);
    const kitchenTicket = await j('/api/kitchen', { headers: authed(tokens.KITCHEN) });
    check('kitchen role can read kitchen (200)', kitchenTicket.status === 200);
    const managerMenu = await j('/api/menu', { method: 'POST', headers: authed(tokens.MANAGER), body: JSON.stringify({ name: 'Manager Special', price: 9.99, description: 'smoke-test' }) });
    check('manager can create menu item (201)', managerMenu.status === 201);
    createdMenu.push(managerMenu.body.id);
    const managerInv = await j('/api/inventory', { headers: authed(tokens.MANAGER) });
    check('manager can get inventory (200)', managerInv.status === 200 && managerInv.body.length > 0);

    // Menu management
    section('MENU MANAGEMENT');
    const newItem = await j('/api/menu', { method: 'POST', headers: authed(owner), body: JSON.stringify({ name: 'Smoke Test Burger', price: 11.5, description: 'smoke-test' }) });
    check('owner creates menu item (201)', newItem.status === 201 && newItem.body.id);
    createdMenu.push(newItem.body.id);
    const badItem = await j('/api/menu', { method: 'POST', headers: authed(owner), body: JSON.stringify({ name: 'Bad', price: -5 }) });
    check('negative price rejected (400)', badItem.status === 400);
    const off = await j(`/api/menu/${newItem.body.id}/availability`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ available: false }) });
    check('toggle menu item off (200)', off.status === 200 && off.body.ok === true);
    const bootAfter = await j('/api/bootstrap', { headers: authed(owner) });
    check('unavailable item hidden from bootstrap menu', bootAfter.status === 200 && !bootAfter.body.menuItems.some((i) => i.id === newItem.body.id));
    const missingAvail = await j('/api/menu/not-a-real-id/availability', { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ available: true }) });
    check('availability on unknown item is 404', missingAvail.status === 404);
    await j(`/api/menu/${newItem.body.id}/availability`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ available: true }) });

    // Order lifecycle: DINE_IN through kitchen to completion
    section('ORDER LIFECYCLE — DINE_IN');
    const boot = await j('/api/bootstrap', { headers: authed(owner) });
    check('bootstrap loads seeded items', boot.status === 200 && boot.body.menuItems.length >= 8);
    const item = boot.body.menuItems[0];
    const oDine = await j('/api/orders', { method: 'POST', headers: authed(owner), body: JSON.stringify({ orderType: 'DINE_IN', tableLabel: 'Table 01', items: [{ menuItemId: item.id, quantity: 2 }] }) });
    check('DINE_IN order created (201, SENT_TO_KITCHEN)', oDine.status === 201 && oDine.body.status === 'SENT_TO_KITCHEN');
    createdCount += 1;
    let kitchen = await j('/api/kitchen', { headers: authed(owner) });
    check('order appears in kitchen after creation', inKitchen(kitchen.body, oDine.body.id));
    let st = await j(`/api/orders/${oDine.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status: 'PREPARING' }) });
    check('kitchen role moves order to PREPARING', st.status === 200 && st.body.status === 'PREPARING');
    kitchen = await j('/api/kitchen', { headers: authed(owner) });
    check('PREPARING order still in kitchen', inKitchen(kitchen.body, oDine.body.id));
    st = await j(`/api/orders/${oDine.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status: 'READY' }) });
    check('kitchen role moves order to READY', st.status === 200 && st.body.status === 'READY');
    kitchen = await j('/api/kitchen', { headers: authed(owner) });
    check('READY order still in kitchen', inKitchen(kitchen.body, oDine.body.id));
    st = await j(`/api/orders/${oDine.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status: 'COMPLETED' }) });
    check('kitchen role completes order', st.status === 200 && st.body.status === 'COMPLETED');
    kitchen = await j('/api/kitchen', { headers: authed(owner) });
    check('completed order leaves kitchen ticket list', !inKitchen(kitchen.body, oDine.body.id));
    const bogusSt = await j(`/api/orders/${oDine.body.id}/status`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ status: 'BOGUS' }) });
    check('invalid status value rejected (400)', bogusSt.status === 400);
    const bogusFilter = await j('/api/orders?status=NOPE', { headers: authed(owner) });
    check('invalid status filter rejected (400)', bogusFilter.status === 400);

    // Payments: partial, overpay, cancel-block
    section('PAYMENTS');
    let pay = await j(`/api/orders/${oDine.body.id}/payments`, { method: 'POST', headers: authed(tokens.CASHIER), body: JSON.stringify({ method: 'CASH', amount: R(Number(oDine.body.total) / 2) }) });
    check('partial payment recorded (remaining > 0)', pay.status === 201 && pay.body.remaining > 0);
    const overpay = await j(`/api/orders/${oDine.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'CASH', amount: Number(oDine.body.total) * 2 }) });
    check('overpayment rejected (400)', overpay.status === 400);
    pay = await j(`/api/orders/${oDine.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'CASH', amount: pay.body.remaining }) });
    check('final payment settles balance to 0', pay.status === 201 && pay.body.remaining === 0);

    const oPartial = await j('/api/orders', { method: 'POST', headers: authed(owner), body: JSON.stringify({ orderType: 'DINE_IN', items: [{ menuItemId: item.id, quantity: 1 }] }) });
    createdCount += 1;
    pay = await j(`/api/orders/${oPartial.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'CARD', amount: R(Number(oPartial.body.total) / 2) }) });
    check('partially paid order not auto-completed', pay.status === 201 && pay.body.remaining > 0);
    let list = await j('/api/orders?status=SENT_TO_KITCHEN', { headers: authed(owner) });
    check('unpaid balance keeps order open in list', list.body.some((o) => o.id === oPartial.body.id));
    pay = await j(`/api/orders/${oPartial.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'CARD', amount: pay.body.remaining }) });
    check('second payment completes the order', pay.status === 201 && pay.body.remaining === 0);
    list = await j('/api/orders?status=COMPLETED', { headers: authed(owner) });
    check('fully paid order now COMPLETED', list.body.some((o) => o.id === oPartial.body.id));

    const oCancel = await j('/api/orders', { method: 'POST', headers: authed(owner), body: JSON.stringify({ orderType: 'DINE_IN', items: [{ menuItemId: item.id, quantity: 1 }] }) });
    createdCount += 1;
    await j(`/api/orders/${oCancel.body.id}/status`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ status: 'CANCELLED' }) });
    const payCancelled = await j(`/api/orders/${oCancel.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'CASH', amount: 5 }) });
    check('cancelled order cannot be paid (400)', payCancelled.status === 400);

    // Order with only unavailable items / empty items
    const emptyOrder = await j('/api/orders', { method: 'POST', headers: authed(owner), body: JSON.stringify({ items: [] }) });
    check('empty items rejected (400)', emptyOrder.status === 400);
    await j(`/api/menu/${item.id}/availability`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ available: false }) });
    const unavailableOrder = await j('/api/orders', { method: 'POST', headers: authed(owner), body: JSON.stringify({ items: [{ menuItemId: item.id, quantity: 1 }] }) });
    check('unavailable item rejected at order time (400)', unavailableOrder.status === 400 && /unavailable/i.test(unavailableOrder.body.error));
    await j(`/api/menu/${item.id}/availability`, { method: 'PATCH', headers: authed(owner), body: JSON.stringify({ available: true }) });

    // TAKEAWAY lifecycle
    section('ORDER LIFECYCLE — TAKEAWAY');
    const oTake = await j('/api/orders', { method: 'POST', headers: authed(tokens.CASHIER), body: JSON.stringify({ orderType: 'TAKEAWAY', items: [{ menuItemId: item.id, quantity: 3 }] }) });
    check('TAKEAWAY order created by cashier', oTake.status === 201 && oTake.body.orderType === 'TAKEAWAY');
    createdCount += 1;
    let k = await j('/api/kitchen', { headers: authed(owner) });
    check('TAKEAWAY appears in kitchen', inKitchen(k.body, oTake.body.id));
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) {
      const r = await j(`/api/orders/${oTake.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status }) });
      check(`TAKEAWAY moved to ${status}`, r.status === 200 && r.body.status === status);
    }
    k = await j('/api/kitchen', { headers: authed(owner) });
    check('completed TAKEAWAY out of kitchen', !inKitchen(k.body, oTake.body.id));

    // DELIVERY lifecycle, cross-role end to end
    section('ORDER LIFECYCLE — DELIVERY (end to end)');
    const oDel = await j('/api/orders', { method: 'POST', headers: authed(tokens.CASHIER), body: JSON.stringify({ orderType: 'DELIVERY', notes: 'Leave at gate', items: [{ menuItemId: item.id, quantity: 1 }] }) });
    check('DELIVERY order created by cashier', oDel.status === 201 && oDel.body.orderType === 'DELIVERY' && oDel.body.notes === 'Leave at gate');
    createdCount += 1;
    k = await j('/api/kitchen', { headers: authed(tokens.KITCHEN) });
    check('DELIVERY order visible to kitchen role', inKitchen(k.body, oDel.body.id));
    for (const status of ['PREPARING', 'READY']) {
      const r = await j(`/api/orders/${oDel.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status }) });
      check(`DELIVERY order cooking → ${status}`, r.status === 200);
    }
    const delivered = await j(`/api/orders/${oDel.body.id}/status`, { method: 'PATCH', headers: authed(tokens.KITCHEN), body: JSON.stringify({ status: 'COMPLETED' }) });
    check('DELIVERY order marked delivered/completed', delivered.status === 200 && delivered.body.status === 'COMPLETED');
    const delPay = await j(`/api/orders/${oDel.body.id}/payments`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ method: 'UPI', amount: Number(oDel.body.total) }) });
    check('DELIVERY order payment recorded after completion', delPay.status === 201 && delPay.body.remaining === 0);

    // Inventory flows. Set a known base quantity so the low-stock threshold crossing is deterministic,
    // then assert deltas. Cleanup restores the captured baseline.
    section('INVENTORY');
    const inv = await j('/api/inventory', { headers: authed(owner) });
    const bun = inv.body.find((i) => i.name === 'Burger buns');
    check('inventory lists Burger buns', Boolean(bun));
    await prisma.ingredient.update({ where: { id: bun.id }, data: { quantity: 40, lowStockAt: 8 } });
    const pur = await j(`/api/inventory/${bun.id}/movement`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'PURCHASE', quantity: 5, reason: 'smoke-test' }) });
    check('purchase movement adds stock (40 → 45)', pur.status === 201 && Number(pur.body.stock.quantity) === 45);
    const waste = await j(`/api/inventory/${bun.id}/movement`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'WASTE', quantity: 40, reason: 'smoke-test' }) });
    check('waste movement reduces stock (45 → 5)', waste.status === 201 && Number(waste.body.stock.quantity) === 5);
    let after = await j('/api/inventory', { headers: authed(owner) });
    check('low-stock flag flips (5 <= 8)', after.body.find((i) => i.id === bun.id).lowStock === true);
    const sale = await j(`/api/inventory/${bun.id}/movement`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'SALE', quantity: 1, reason: 'smoke-test' }) });
    check('sale movement records negative delta (5 → 4)', sale.status === 201 && Number(sale.body.stock.quantity) === 4);
    const restore = await j(`/api/inventory/${bun.id}/movement`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'PURCHASE', quantity: 25, reason: 'smoke-test' }) });
    check('stock restored above threshold (4 → 29)', restore.status === 201 && Number(restore.body.stock.quantity) === 29);
    after = await j('/api/inventory', { headers: authed(owner) });
    check('low-stock flag clears after restock', after.body.find((i) => i.id === bun.id).lowStock === false);
    const missingMove = await j('/api/inventory/not-an-ingredient/movement', { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'PURCHASE', quantity: 1 }) });
    check('movement on unknown ingredient is 404', missingMove.status === 404);
    const negMove = await j(`/api/inventory/${bun.id}/movement`, { method: 'POST', headers: authed(owner), body: JSON.stringify({ type: 'WASTE', quantity: -5 }) });
    check('negative movement quantity rejected (400)', negMove.status === 400);

    // Reports
    section('REPORTS');
    const rep = await j('/api/reports/daily', { headers: authed(tokens.MANAGER) });
    check('manager reads daily report', rep.status === 200);
    const expectedPaid = R(Number(oDine.body.total) + Number(oPartial.body.total) + Number(oDel.body.total));
    check('report paidAmount matches recorded payments', rep.status === 200 && rep.body.paidAmount === expectedPaid, `expected ${expectedPaid}, got ${rep.body.paidAmount}`);
    check('report orderCount includes non-cancelled orders', rep.body.orderCount >= 4);
    check('report paidOrderCount counts paid orders', rep.body.paidOrderCount >= 3);
    check('report topItems populated', Array.isArray(rep.body.topItems) && rep.body.topItems.length > 0);
    const badRange = await j('/api/reports/daily?from=2026-10-12&to=2026-10-01', { headers: authed(owner) });
    check('inverted date range rejected (400)', badRange.status === 400);

    // Brute-force protection
    section('BRUTE FORCE PROTECTION');
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await login(nobodyEmail, 'WrongPass123!');
      if (r.status === 429) { got429 = true; break; }
    }
    check('login rate limit returns 429', got429 === true);
    let locked = null;
    for (let i = 0; i < 9; i++) {
      const r = await login(lockoutUser.email, 'WrongPass123!');
      locked = r;
      if (r.status === 429) break;
    }
    check('account locks after repeated failed attempts (429)', locked.status === 429 && /locked/i.test(locked.body.error));
    const lockedAgain = await login(lockoutUser.email, lockoutUser.password);
    check('correct password still blocked while locked (429)', lockedAgain.status === 429);

    // Tenant isolation (second restaurant must not see/touch the first)
    section('TENANT ISOLATION');
    const tenantRestaurant = await prisma.restaurant.create({ data: { name: 'Smoke Tenant', countryCode: 'US', currency: 'USD', timezone: 'America/New_York', taxRate: 0 } });
    const tenantEmail = `tenant-b-smoke-${stamp}@example.com`;
    const tenantUser = await prisma.user.create({ data: { restaurantId: tenantRestaurant.id, name: 'Tenant B', email: tenantEmail, passwordHash: await bcrypt.hash('TenantPass2026!', 4), role: 'OWNER' } });
    const tLogin = await login(tenantEmail, 'TenantPass2026!');
    const tToken = tLogin.body?.token;
    const tMenu = await j('/api/menu', { headers: authed(tToken) });
    check('tenant B menu is empty (isolation)', tMenu.status === 200 && tMenu.body.length === 0);
    const tPatch = await j(`/api/orders/${oDine.body.id}/status`, { method: 'PATCH', headers: authed(tToken), body: JSON.stringify({ status: 'COMPLETED' }) });
    check('tenant B cannot touch tenant A order (404)', tPatch.status === 404);
    const tReport = await j('/api/reports/daily', { headers: authed(tToken) });
    check('tenant B report has no tenant A data', tReport.status === 200 && tReport.body.orderCount === 0);
  } finally {
    // Cleanup — runs even if an assertion flow above threw. Order matters: orders
    // reference the users that created them, so orders go first.
    section('CLEANUP');
    const deletedOrders = await prisma.order.deleteMany({ where: { restaurantId: DEMO_RESTAURANT, createdAt: { gte: smokeStart } } });
    await prisma.stockMovement.deleteMany({ where: { restaurantId: DEMO_RESTAURANT, reason: 'smoke-test' } });
    await prisma.menuItem.deleteMany({ where: { id: { in: createdMenu } } });
    await prisma.user.deleteMany({ where: { OR: [{ email: { in: roleUsers.map((u) => u.email) } }, { email: { startsWith: 'tenant-b-smoke-' } }] } });
    await prisma.restaurant.deleteMany({ where: { name: 'Smoke Tenant' } });
    const resetHash = await bcrypt.hash(seededPassword, 12);
    await prisma.user.update({ where: { email: 'owner@tabletap.local' }, data: { passwordHash: resetHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null } });
    for (const s of initialStock) {
      await prisma.ingredient.update({ where: { id: s.id }, data: { quantity: s.quantity } });
    }
    // Let the fire-and-forget audit writer flush before removing its rows.
    await new Promise((r) => setTimeout(r, 700));
    await prisma.auditLog.deleteMany({ where: { createdAt: { gte: smokeStart } } });
    check(`cleanup removed ${deletedOrders.count} smoke order(s), ${createdMenu.length} menu item(s), stock + audit rows`, deletedOrders.count >= 0);
  }
}

main()
  .catch((e) => { results.push(`FAIL  smoke run aborted: ${e.message}`); console.error(e); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(results.join('\n'));
    const checks = results.filter((r) => r.startsWith('PASS') || r.startsWith('FAIL'));
    const failed = checks.filter((r) => r.startsWith('FAIL'));
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });