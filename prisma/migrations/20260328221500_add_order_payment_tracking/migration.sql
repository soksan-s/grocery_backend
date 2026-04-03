CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'failed', 'expired');

ALTER TABLE "Order"
ADD COLUMN "tranId" TEXT,
ADD COLUMN "paymentGateway" TEXT,
ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN "paymentAmount" DOUBLE PRECISION,
ADD COLUMN "paymentCurrency" TEXT,
ADD COLUMN "paymentExpiresAt" TIMESTAMP(3),
ADD COLUMN "paymentPaidAt" TIMESTAMP(3),
ADD COLUMN "paymentVerifiedAt" TIMESTAMP(3),
ADD COLUMN "paymentLastCheckedAt" TIMESTAMP(3),
ADD COLUMN "paymentCallbackReceivedAt" TIMESTAMP(3),
ADD COLUMN "paymentCallbackStatus" TEXT,
ADD COLUMN "paymentApprovalCode" TEXT,
ADD COLUMN "paymentFailureReason" TEXT;

CREATE UNIQUE INDEX "Order_tranId_key" ON "Order"("tranId");
