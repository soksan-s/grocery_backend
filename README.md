# Grocery API (Node + Express + Prisma + Railway)

## Setup

```bash
cd server
npm install
copy .env.example .env
```

Set `DATABASE_URL`, `JWT_SECRET`, and the ABA PayWay variables in `server/.env`.

## ABA PayWay KHQR

Required variables:

- `ABA_MERCHANT_ID`
- `ABA_API_KEY`
- `ABA_API_URL`
- `ABA_CHECK_TRANSACTION_URL`
- `BASE_URL`

Recommended sandbox defaults:

- `ABA_API_URL=https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr`
- `ABA_CHECK_TRANSACTION_URL=https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/check-transaction-2`
- `ABA_PAYMENT_OPTION=abapay_khqr`
- `ABA_QR_TEMPLATE=template3_color`
- `ABA_QR_LIFETIME_MINUTES=3`

Notes:

- ABA sandbox requires your Railway domain or outbound IP to be whitelisted.
- The callback endpoint is `/api/payments/callback`.
- The callback is treated only as a signal; the server always verifies the transaction with ABA before marking an order paid.

## Payment Endpoints

- `POST /api/payments/create`
- `POST /api/payments/callback`
- `GET /api/payments/status/:tranId`

`POST /api/payments/create` can either:

- create a new order plus KHQR session from checkout data
- regenerate a QR for an existing unpaid order by passing `orderId`

## Orders

- `GET /api/orders`
- `GET /api/orders/me`
- `POST /api/orders`
- `PATCH /api/orders/:id/status`
- `GET /api/orders/:id/lines`

## Prisma

```bash
npx prisma migrate deploy
npx prisma generate
```

## Run

```bash
npm run dev
```
