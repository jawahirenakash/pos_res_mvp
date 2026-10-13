import { prisma } from './db.js';

// Atomic per-restaurant order number allocation.
//
// A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement takes a row
// lock, so concurrent terminals are serialized by Postgres and can never receive
// the same number. On first use the counter is seeded from any pre-existing
// orders (MAX + 1); after that it increments atomically. Gaps are possible if an
// order insert later fails, which is harmless (numbers must be unique, not dense).
export async function allocateOrderNumber(restaurantId) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "RestaurantOrderCounter" ("restaurantId", "lastOrderNumber", "updatedAt")
    VALUES (
      ${restaurantId},
      COALESCE((SELECT MAX("orderNumber") FROM "Order" WHERE "restaurantId" = ${restaurantId}), 1000) + 1,
      NOW()
    )
    ON CONFLICT ("restaurantId") DO UPDATE
      SET "lastOrderNumber" = "RestaurantOrderCounter"."lastOrderNumber" + 1,
          "updatedAt" = NOW()
    RETURNING "lastOrderNumber"
  `;
  return Number(rows[0].lastOrderNumber);
}
