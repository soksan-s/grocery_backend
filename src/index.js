import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import path from 'node:path';

import prisma from './db.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import restockRoutes from './routes/restocks.js';
import uploadRoutes from './routes/uploads.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/restocks', restockRoutes);
app.use('/api/uploads', uploadRoutes);

seedAdmin()
  .then(seedProducts)
  .catch((err) => console.error('Seed failed:', err));

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
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
