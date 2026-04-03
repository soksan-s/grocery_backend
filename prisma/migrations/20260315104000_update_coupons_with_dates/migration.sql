-- CreateEnum
CREATE TYPE "CouponAudience" AS ENUM ('all', 'user');

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN "audience" "CouponAudience" NOT NULL DEFAULT 'all';
ALTER TABLE "Coupon" ADD COLUMN "description" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "startsAt" TIMESTAMP(3);
ALTER TABLE "Coupon" ADD COLUMN "endsAt" TIMESTAMP(3);
ALTER TABLE "Coupon" ADD COLUMN "userEmail" TEXT;
