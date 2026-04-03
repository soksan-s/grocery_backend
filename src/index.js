import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import path from 'node:path';

import prisma from './db.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import restockRoutes from './routes/restocks.js';
import uploadRoutes from './routes/uploads.js';
import categoryRoutes from './routes/categories.js';
import couponRoutes from './routes/coupons.js';
import favoriteRoutes from './routes/favorites.js';
import supportRoutes from './routes/support.js';
import ratingRoutes from './routes/ratings.js';
import commentRoutes from './routes/comments.js';
import paywayRoutes from './routes/payway.js';
import paymentRoutes from './routes/payments.js';
import deliveryLocationRoutes from './routes/delivery_locations.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const databaseUrl = process.env.DATABASE_URL ?? '';
const hasUsableDatabaseUrl =
  databaseUrl.length > 0 && !databaseUrl.includes('USER:PASSWORD@HOST');
const isProduction = process.env.NODE_ENV === 'production';
const corsOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const allowAllOrigins = corsOrigins.includes('*');
const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.set('trust proxy', 1);
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isProduction,
  }),
);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      if (allowAllOrigins) {
        return callback(null, true);
      }
      if (corsOrigins.includes(origin) || localhostOrigin.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  }),
);
app.use(express.json());

app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    databaseConfigured: hasUsableDatabaseUrl,
    mode: hasUsableDatabaseUrl ? 'database' : 'demo',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/restocks', restockRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/payway', paywayRoutes);
app.use('/api/delivery-locations', deliveryLocationRoutes);

if (process.env.SEED_ON_STARTUP === 'true') {
  seedAdmin()
    .then(seedProducts)
    .catch((err) => console.error('Seed failed:', err));
}

// app.listen(port, () => {
//   console.log(`API listening on port ${port}`);
  app.listen(port, '0.0.0.0', () => {
  console.log(`API listening on port ${port}`);
  if (!hasUsableDatabaseUrl) {
    console.warn(
      'DATABASE_URL is missing or still using the placeholder value. Public catalog routes will use demo fallback data.',
    );
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ error: 'Internal server error.' });
});

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return;
  }

  const hash = bcrypt.hashSync(password, 10);
  await prisma.user.create({
    data: {
      email,
      passwordHash: hash,
      role: 'admin',
    },
  });
}

async function seedProducts() {
  const count = await prisma.product.count();
  if (count > 0) {
    return;
  }

  const items = [
    {
      id: 'p1',
      name: 'Fresh Apples',
      category: 'Fruits',
      description: 'Crisp and sweet red apples, sold per kg.',
      price: 3.25,
      imageUrl: 'https://picsum.photos/seed/apples/900/500',
      stock: 40,
    },
    {
      id: 'p2',
      name: 'Whole Milk',
      category: 'Dairy',
      description: '1L whole milk from local farms.',
      price: 1.99,
      imageUrl: 'https://picsum.photos/seed/milk/900/500',
      stock: 30,
    },
    {
      id: 'p3',
      name: 'Basmati Rice',
      category: 'Grains',
      description: 'Premium long-grain basmati rice, 5kg bag.',
      price: 12.5,
      imageUrl: 'https://picsum.photos/seed/rice/900/500',
      stock: 18,
    },
    {
      id: 'p4',
      name: 'Chicken Breast',
      category: 'Meat',
      description: 'Boneless chicken breast, approx. 500g tray.',
      price: 5.4,
      imageUrl: 'https://picsum.photos/seed/chicken/900/500',
      stock: 22,
    },
    
  ];

  for (const item of items) {
    await prisma.product.create({ data: item });
  }
}
