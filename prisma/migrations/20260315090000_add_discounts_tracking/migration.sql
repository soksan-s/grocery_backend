-- Add discount percent to Product
ALTER TABLE "Product" ADD COLUMN "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Add tracking fields to Order
ALTER TABLE "Order" ADD COLUMN "trackingNumber" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingCarrier" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "trackingUpdatedAt" TIMESTAMP(3);

-- Add discount percent to OrderLine
ALTER TABLE "OrderLine" ADD COLUMN "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
