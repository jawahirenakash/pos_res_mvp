// Concurrency proof for the atomic per-restaurant order-number allocator.
//
// Fires N simultaneous order creations and asserts every order received a unique
// number. The old `max(orderNumber) + 1` approach would collide here; this proves
// the counter-table approach does not. Requires the server to be running.
//
// Usage:  node scripts/concurrency.mjs        (default 40 concurrent orders)
//         RACE_N=200 node scripts/concurrency.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BASE = 'http://localhost:4000';
const RID = 'demo-restaurant';
const EMAIL = 'race-cashier@example.com';
const PASSWORD = 'RacePass2026!x';
const N = Number(process.env.RACE_N || 40);
const prisma = new PrismaClient();

const j = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch(`${BASE}${path}`, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

async function main() {
  // A dedicated user keeps the demo owner account and its forced password change untouched.
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { restaurantId: RID, passwordHash, mustChangePassword: false, active: true, failedLoginAttempts: 0, lockedUntil: null },
    create: { restaurantId: RID, name: 'Race Cashier', email: EMAIL, passwordHash, role: 'CASHIER', mustChangePassword: false }
  });

  const login = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const auth = { Authorization: `Bearer ${login.body.token}` };

  const menu = await j('/api/menu', { headers: auth });
  const item = (menu.body || []).find((m) => m.available);
  if (!item) throw new Error('no available menu item to order');

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      j('/api/orders', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ orderType: 'TAKEAWAY', items: [{ menuItemId: item.id, quantity: 1 }] })
      })
    )
  );
  const ms = Date.now() - started;

  const ok = results.filter((r) => r.status === 201);
  const numbers = ok.map((r) => r.body.orderNumber);
  const unique = new Set(numbers);
  const failures = results.filter((r) => r.status !== 201).map((r) => `${r.status}:${r.body.error}`);

  console.log(`fired ${N} concurrent orders in ${ms}ms (${Math.round((N / ms) * 1000)}/s)`);
  console.log(`created=${ok.length} uniqueNumbers=${unique.size} duplicates=${numbers.length - unique.size}`);
  if (failures.length) console.log(`failures(${failures.length}):`, failures.slice(0, 5).join(', '));

  // Cleanup: drop only what this run created, then reset the counter so the next
  // allocation reseeds from the remaining orders.
  await prisma.order.deleteMany({ where: { restaurantId: RID, createdById: user.id } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: EMAIL } });
  await prisma.restaurantOrderCounter.deleteMany({ where: { restaurantId: RID } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  const pass = ok.length === N && unique.size === N && failures.length === 0;
  console.log(pass ? 'PASS  every order number is unique under concurrency' : 'FAIL  collision, error, or dropped request');
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
