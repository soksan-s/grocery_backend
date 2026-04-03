# Grocery API (Node + Express + Prisma + Railway)

## Setup

```bash
cd server
npm install
copy .env.example .env
```

Set `DATABASE_URL`, `JWT_SECRET`, and the ABA PayWay variables in `server/.env`.

Google Sign-In also requires:

- `GOOGLE_CLIENT_ID`
  Use your Google OAuth Web client ID here, for example `GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com`.
  The backend verifies every mobile ID token against this audience with `google-auth-library`, which follows Google's server-side verification guidance.

Email delivery with Gmail SMTP requires:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
  Example: `EMAIL_FROM=Grocery App <your-account@gmail.com>`
  Gmail SMTP usually uses `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and a Google App Password for `SMTP_PASS`.

Railway note:

- Railway does not use your local `server/.env` file from GitHub. Add the same variables in the Railway service settings.
- If `BASE_URL` is not set, the payment route now falls back to the request's public host, but setting `BASE_URL` explicitly is still recommended.

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

## Google Auth

- `POST /api/auth/google`

Backend notes:

- Verify Google ID tokens on the server, not only in Flutter.
- The value in `server/.env` for `GOOGLE_CLIENT_ID` must match the web client ID used by the Flutter app when requesting Google ID tokens.
- Existing email/password users are linked by matching email, then marked `emailVerified=true`.

## Email Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `POST /api/auth/send-email-verification`
- `POST /api/auth/verify-email`

Backend notes:

- New email/password users are created as `emailVerified=false`.
- Registration now generates a verification code and sends it through Gmail SMTP with Nodemailer.
- Email/password login is blocked until the email address is verified.
- Password reset and resend-verification also send real emails through Gmail SMTP with Nodemailer.

## Prisma

```bash
npx prisma migrate deploy
npx prisma generate
```

## Run

```bash
npm run dev
```
