CREATE TABLE "DeliveryLocation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "placeLabel" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryLocation_userId_latitude_longitude_key"
ON "DeliveryLocation"("userId", "latitude", "longitude");

CREATE INDEX "DeliveryLocation_userId_isDefault_updatedAt_idx"
ON "DeliveryLocation"("userId", "isDefault", "updatedAt");

ALTER TABLE "DeliveryLocation"
ADD CONSTRAINT "DeliveryLocation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
