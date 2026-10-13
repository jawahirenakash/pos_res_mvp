-- CreateTable
CREATE TABLE "RestaurantOrderCounter" (
    "restaurantId" TEXT NOT NULL,
    "lastOrderNumber" INTEGER NOT NULL DEFAULT 1000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantOrderCounter_pkey" PRIMARY KEY ("restaurantId")
);
