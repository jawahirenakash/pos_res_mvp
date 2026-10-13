import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from './db.js';
import { authenticate, allowRoles, JWT_ISSUER, JWT_AUDIENCE } from './auth.js';
import { config } from './config.js';
import { rateLimit } from './rate-limit.js';
import { audit } from './audit.js';
import { checkPassword, PASSWORD_MIN } from './validate.js';
import { idempotencyMiddleware } from './idempotency.js';
import { getCache, setCache, delCache } from './cache.js';
import { allocateOrderNumber } from './order-number.js';

const app = express(), dir = path.dirname(fileURLToPath(import.meta.url));
const ORDER_STATUSES = ['OPEN','SENT_TO_KITCHEN','PREPARING','READY','COMPLETED','CANCELLED'];
const MAX_FAILED_LOGINS = 8, LOCKOUT_MS = 15 * 60 * 1000;

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      upgradeInsecureRequests: config.isProd ? [] : null
    }
  },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  xFrameOptions: { action: 'deny' }
}));
// The UI is served from this same origin, so CORS is off unless explicitly configured.
if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins, credentials: false, methods: ['GET','POST','PATCH','OPTIONS'] }));
app.use(rateLimit({ windowMs: 60_000, max: config.globalRateLimit, scope: 'global' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(dir, '..', 'public')));

const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

app.get('/api/health', (_q, s) => s.json({ ok: true, app: 'TableTap POS' }));

// Allocate the next order number atomically per restaurant (counter table), so
// concurrent terminals cannot collide on [restaurantId, orderNumber].
async function createOrder(data) {
  const orderNumber = await allocateOrderNumber(data.restaurantId);
  return prisma.order.create({ data: { ...data, orderNumber }, include: { items: true } });
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, scope: 'login', message: 'Too many sign-in attempts. Try again in a few minutes.', keyFn: (r) => `${r.ip}|${String(r.body?.email || '').toLowerCase()}` });
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const p = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter valid email and password' });
  const email = p.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    audit(req, 'auth.login_blocked', { restaurantId: user.restaurantId, actorEmail: email });
    return res.status(429).json({ error: 'Account temporarily locked after repeated failed sign-ins. Try again later.' });
  }
  const ok = Boolean(user) && user.active && await bcrypt.compare(p.data.password, user.passwordHash);
  if (!ok) {
    if (user) {
      const prior = user.lockedUntil && user.lockedUntil <= new Date() ? 0 : user.failedLoginAttempts;
      const attempts = prior + 1;
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attempts, lockedUntil: attempts >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null } });
      audit(req, 'auth.login_failed', { restaurantId: user.restaurantId, actorEmail: email });
    } else {
      audit(req, 'auth.login_failed', { actorEmail: email });
    }
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.tokenTtl, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' });
  audit(req, 'auth.login', { restaurantId: user.restaurantId, actorUserId: user.id, actorEmail: user.email });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, restaurantId: user.restaurantId, mustChangePassword: user.mustChangePassword } });
});

app.use('/api', authenticate);
// Enforce the seeded account's forced password change even after a reload (API token still valid).
app.use('/api', (q, s, n) => { const p = q.originalUrl.split('?')[0]; if (q.user.mustChangePassword && !['/api/me', '/api/auth/change-password'].includes(p)) return s.status(403).json({ error: 'Set a new password before continuing' }); n(); });
// Idempotency for mutating requests, keyed per restaurant. Must run after auth.
app.use('/api', idempotencyMiddleware());

app.get('/api/me', (q, s) => s.json({ id: q.user.id, name: q.user.name, email: q.user.email, role: q.user.role, mustChangePassword: q.user.mustChangePassword }));
app.post('/api/auth/change-password', async (q, s) => {
  const p = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters` });
  const problem = checkPassword(p.data.newPassword);
  if (problem) return s.status(400).json({ error: problem });
  if (!await bcrypt.compare(p.data.currentPassword, q.user.passwordHash)) { audit(q, 'auth.change_password_failed'); return s.status(400).json({ error: 'Current password is incorrect' }); }
  if (await bcrypt.compare(p.data.newPassword, q.user.passwordHash)) return s.status(400).json({ error: 'Choose a password different from the current one' });
  await prisma.user.update({ where: { id: q.user.id }, data: { passwordHash: await bcrypt.hash(p.data.newPassword, 12), mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null } });
  audit(q, 'auth.change_password');
  s.json({ ok: true });
});

app.get('/api/bootstrap', async (q, s) => {
  const id = q.user.restaurantId, cacheKey = `bootstrap:${id}`;
  const cached = await getCache(cacheKey);
  if (cached) return s.json(cached);
  const [restaurant, categories, menuItems, tables] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id } }),
    prisma.category.findMany({ where: { restaurantId: id }, orderBy: { sortOrder: 'asc' } }),
    prisma.menuItem.findMany({ where: { restaurantId: id, available: true }, include: { category: true }, orderBy: { name: 'asc' } }),
    prisma.diningTable.findMany({ where: { restaurantId: id, active: true }, orderBy: { label: 'asc' } })
  ]);
  const result = { restaurant, categories, menuItems, tables };
  await setCache(cacheKey, result, 30);
  s.json(result);
});
app.get('/api/menu', async (q, s) => {
  const cacheKey = `menu:${q.user.restaurantId}`;
  const cached = await getCache(cacheKey);
  if (cached) return s.json(cached);
  const result = await prisma.menuItem.findMany({ where: { restaurantId: q.user.restaurantId }, include: { category: true }, orderBy: { name: 'asc' } });
  await setCache(cacheKey, result, 60);
  s.json(result);
});
app.post('/api/menu', allowRoles('OWNER','MANAGER'), async (q, s) => {
  const p = z.object({ name: z.string().trim().min(1).max(100), price: z.number().nonnegative().max(1000000), categoryId: z.string().nullable().optional(), description: z.string().max(300).optional() }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'Invalid menu item' });
  const item = await prisma.menuItem.create({ data: { ...p.data, restaurantId: q.user.restaurantId, price: round(p.data.price) } });
  await delCache(`bootstrap:${q.user.restaurantId}`);
  await delCache(`menu:${q.user.restaurantId}`);
  audit(q, 'menu.create', { entityType: 'MenuItem', entityId: item.id, detail: { name: item.name } });
  s.status(201).json(item);
});
app.patch('/api/menu/:id/availability', allowRoles('OWNER','MANAGER'), async (q, s) => {
  const p = z.object({ available: z.boolean() }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'available must be boolean' });
  const x = await prisma.menuItem.updateMany({ where: { id: q.params.id, restaurantId: q.user.restaurantId }, data: { available: p.data.available } });
  if (!x.count) return s.status(404).json({ error: 'Menu item not found' });
  await delCache(`bootstrap:${q.user.restaurantId}`);
  await delCache(`menu:${q.user.restaurantId}`);
  audit(q, 'menu.availability', { entityType: 'MenuItem', entityId: q.params.id, detail: { available: p.data.available } });
  s.json({ ok: true });
});

app.post('/api/orders', async (q, s) => {
  const p = z.object({ orderType: z.enum(['DINE_IN','TAKEAWAY','DELIVERY']).default('DINE_IN'), tableLabel: z.string().max(40).nullable().optional(), discountPercent: z.number().min(0).max(100).default(0), tip: z.number().min(0).max(100000).default(0), notes: z.string().max(500).optional(), items: z.array(z.object({ menuItemId: z.string().max(64), quantity: z.number().int().min(1).max(99), notes: z.string().max(200).optional() })).min(1).max(100) }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'Invalid order', details: p.error.flatten() });
  const r = await prisma.restaurant.findUnique({ where: { id: q.user.restaurantId } });
  const ids = [...new Set(p.data.items.map((i) => i.menuItemId))];
  const products = await prisma.menuItem.findMany({ where: { id: { in: ids }, restaurantId: r.id, available: true } });
  if (products.length !== ids.length) return s.status(400).json({ error: 'One or more items are unavailable' });
  const byId = new Map(products.map((i) => [i.id, i]));
  const lines = p.data.items.map((i) => { const m = byId.get(i.menuItemId), price = round(m.price); return { menuItemId: m.id, nameSnapshot: m.name, unitPrice: price, quantity: i.quantity, lineTotal: round(price * i.quantity), notes: i.notes }; });
  const subtotal = round(lines.reduce((a, i) => a + i.lineTotal, 0)), discount = round(subtotal * p.data.discountPercent / 100), tax = round((subtotal - discount) * Number(r.taxRate)), total = round(subtotal - discount + tax + p.data.tip);
  const order = await createOrder({ restaurantId: r.id, createdById: q.user.id, orderType: p.data.orderType, tableLabel: p.data.tableLabel || null, subtotal, discount, tax, tip: p.data.tip, total, status: 'SENT_TO_KITCHEN', currency: r.currency, notes: p.data.notes, items: { create: lines } });
  audit(q, 'order.create', { entityType: 'Order', entityId: order.id, detail: { orderNumber: order.orderNumber, total } });
  s.status(201).json(order);
});
app.get('/api/orders', async (q, s) => {
  const status = q.query.status ? String(q.query.status) : null;
  if (status && !ORDER_STATUSES.includes(status)) return s.status(400).json({ error: 'Invalid status filter' });
  const take = Math.min(Math.max(Number(q.query.limit) || 100, 1), 200);
  s.json(await prisma.order.findMany({ where: { restaurantId: q.user.restaurantId, ...(status ? { status } : {}) }, include: { items: true, payments: true }, orderBy: { createdAt: 'desc' }, take }));
});
app.patch('/api/orders/:id/status', async (q, s) => {
  const p = z.object({ status: z.enum(ORDER_STATUSES) }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'Invalid status' });
  const old = await prisma.order.findFirst({ where: { id: q.params.id, restaurantId: q.user.restaurantId } });
  if (!old) return s.status(404).json({ error: 'Order not found' });
  const updated = await prisma.order.update({ where: { id: old.id }, data: { status: p.data.status } });
  audit(q, 'order.status', { entityType: 'Order', entityId: old.id, detail: { from: old.status, to: p.data.status } });
  s.json(updated);
});
app.post('/api/orders/:id/payments', async (q, s) => {
  const p = z.object({ method: z.enum(['CASH','CARD','UPI','OTHER']), amount: z.number().positive().max(1000000), provider: z.string().max(80).optional(), providerRef: z.string().max(200).optional() }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'Invalid payment' });
  const o = await prisma.order.findFirst({ where: { id: q.params.id, restaurantId: q.user.restaurantId }, include: { payments: true } });
  if (!o) return s.status(404).json({ error: 'Order not found' });
  if (o.status === 'CANCELLED') return s.status(400).json({ error: 'Cancelled order cannot be paid' });
  const paid = round(o.payments.filter((x) => x.status === 'PAID').reduce((a, x) => a + Number(x.amount), 0)), remaining = round(Number(o.total) - paid);
  if (round(p.data.amount) > remaining) return s.status(400).json({ error: `Payment exceeds balance ${remaining}` });
  /* Demo ledger only: this does not collect money. */
  const payment = await prisma.payment.create({ data: { orderId: o.id, method: p.data.method, amount: round(p.data.amount), provider: p.data.provider, providerRef: p.data.providerRef, status: 'PAID' } });
  const next = round(paid + Number(payment.amount));
  if (next >= Number(o.total)) await prisma.order.update({ where: { id: o.id }, data: { status: 'COMPLETED' } });
  audit(q, 'payment.record', { entityType: 'Payment', entityId: payment.id, detail: { orderId: o.id, method: payment.method, amount: payment.amount } });
  s.status(201).json({ payment, paid: next, remaining: round(Number(o.total) - next), demoMode: true });
});
app.get('/api/kitchen', async (q, s) => s.json(await prisma.order.findMany({ where: { restaurantId: q.user.restaurantId, status: { in: ['SENT_TO_KITCHEN','PREPARING','READY'] } }, include: { items: true }, orderBy: { createdAt: 'asc' } })));
app.get('/api/inventory', allowRoles('OWNER','MANAGER'), async (q, s) => { const rows = await prisma.ingredient.findMany({ where: { restaurantId: q.user.restaurantId }, orderBy: { name: 'asc' } }); s.json(rows.map((x) => ({ ...x, lowStock: Number(x.quantity) <= Number(x.lowStockAt) }))); });
app.post('/api/inventory/:id/movement', allowRoles('OWNER','MANAGER'), async (q, s) => {
  const p = z.object({ type: z.enum(['PURCHASE','SALE','WASTE','ADJUSTMENT']), quantity: z.number().positive().max(1000000), reason: z.string().max(200).optional() }).safeParse(q.body);
  if (!p.success) return s.status(400).json({ error: 'Invalid stock movement' });
  const i = await prisma.ingredient.findFirst({ where: { id: q.params.id, restaurantId: q.user.restaurantId } });
  if (!i) return s.status(404).json({ error: 'Ingredient not found' });
  const delta = p.data.type === 'PURCHASE' ? p.data.quantity : -p.data.quantity;
  const out = await prisma.$transaction(async (tx) => ({ move: await tx.stockMovement.create({ data: { restaurantId: q.user.restaurantId, ingredientId: i.id, type: p.data.type, quantityDelta: delta, reason: p.data.reason } }), stock: await tx.ingredient.update({ where: { id: i.id }, data: { quantity: { increment: delta } } }) }));
  audit(q, 'inventory.movement', { entityType: 'Ingredient', entityId: i.id, detail: { type: p.data.type, delta } });
  s.status(201).json(out);
});
app.get('/api/reports/daily', allowRoles('OWNER','MANAGER'), async (q, s) => {
  const from = q.query.from ? new Date(String(q.query.from)) : new Date(new Date().setHours(0, 0, 0, 0)), to = q.query.to ? new Date(String(q.query.to)) : new Date(new Date().setHours(23, 59, 59, 999));
  if (isNaN(from) || isNaN(to) || from > to) return s.status(400).json({ error: 'Invalid date range' });
  const orders = await prisma.order.findMany({ where: { restaurantId: q.user.restaurantId, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } }, include: { payments: true, items: true } });
  const paidAmount = round(orders.reduce((a, o) => a + o.payments.filter((x) => x.status === 'PAID').reduce((b, x) => b + Number(x.amount), 0), 0)), sold = {};
  for (const o of orders) for (const i of o.items) sold[i.nameSnapshot] = (sold[i.nameSnapshot] || 0) + i.quantity;
  s.json({ from, to, orderCount: orders.length, paidOrderCount: orders.filter((o) => o.payments.some((x) => x.status === 'PAID')).length, paidAmount, topItems: Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, quantity]) => ({ name, quantity })) });
});

app.use((_q, s) => s.status(404).json({ error: 'Not found' }));
app.use((err, _q, s, _n) => { if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return s.status(400).json({ error: 'Invalid JSON body' }); if (err?.status && err.status >= 400) return s.status(err.status).json({ error: err.message }); console.error(err); s.status(500).json({ error: 'Unexpected server error' }); });
app.listen(config.port, () => console.log(`TableTap POS running at http://localhost:${config.port}`));