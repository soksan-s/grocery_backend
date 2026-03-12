# Grocery API (Node + Express + Prisma + Neon)

## Setup

```bash
cd server
npm install
cp .env.example .env
```

### 1. Set Neon connection string

Set `DATABASE_URL` in `.env` from Neon Console.

### 2. Configure Cloudinary

Set:
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER` (optional)

### 3. Create tables

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 4. Run API

```bash
npm run dev
```

## Auth

- `POST /api/auth/register`
- `POST /api/auth/login`

## Products

- `GET /api/products`
- `GET /api/products/:id`
- `POST /api/products` (admin)
- `PUT /api/products/:id` (admin)
- `DELETE /api/products/:id` (admin)
- `POST /api/products/:id/restock` (admin)

## Orders

- `GET /api/orders` (admin)
- `GET /api/orders/me` (client)
- `POST /api/orders` (client)
- `PATCH /api/orders/:id/status` (admin)
- `GET /api/orders/:id/lines` (admin or owner)

## Restocks

- `GET /api/restocks` (admin)

## Uploads (Cloudinary)

- `POST /api/uploads` (admin, multipart `image` field)
- Response: `{ url, publicId }`

## Notes

- Admin seed uses `ADMIN_EMAIL` + `ADMIN_PASSWORD` from `.env`.
- Auth uses JWT (`Authorization: Bearer <token>`).
- Prisma schema at `server/prisma/schema.prisma`.
