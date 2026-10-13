import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
const DEMO = 'demo-restaurant';
const seeded = process.env.SEED_OWNER_PASSWORD || '';

const orders = await prisma.order.deleteMany({ where: { restaurantId: DEMO } });
const items = await prisma.menuItem.deleteMany({ where: { restaurantId: DEMO, OR: [{ description: 'smoke-test' }, { name: 'Manager Special' }] } });
const moves = await prisma.stockMovement.deleteMany({ where: { restaurantId: DEMO } });
// Smoke/role fixtures use timestamped `*-smoke-<ts>@example.com` addresses; seed data only uses owner@tabletap.local.
const users = await prisma.user.deleteMany({ where: { email: { endsWith: '@example.com' } } });
const tenants = await prisma.restaurant.deleteMany({ where: { name: 'Smoke Tenant' } });
await prisma.user.update({ where: { email: 'owner@tabletap.local' }, data: { passwordHash: await bcrypt.hash(seeded, 12), mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null } });
for (const [name, quantity] of [['Burger buns', 30], ['Cheddar slices', 24], ['Coffee beans', 1500], ['Milk', 8000], ['Potatoes', 12]]) {
  await prisma.ingredient.updateMany({ where: { restaurantId: DEMO, name }, data: { quantity } });
}
const audit = await prisma.auditLog.deleteMany({});
const counters = await prisma.restaurantOrderCounter.deleteMany({ where: { restaurantId: DEMO } });
console.log(`removed orders=${orders.count} items=${items.count} moves=${moves.count} users=${users.count} tenants=${tenants.count} audit=${audit.count} counters=${counters.count}`);
console.log('remaining:', await prisma.order.count(), 'orders,', await prisma.user.count(), 'users,', await prisma.auditLog.count(), 'audit');
await prisma.$disconnect();