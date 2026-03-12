import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const rows = await prisma.order.findMany({
    include: { customer: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(rows.map(mapOrder));
});

router.get('/me', requireAuth, async (req, res) => {
  const rows = await prisma.order.findMany({
    where: { customerId: req.user.id },
    include: { customer: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(rows.map(mapOrder));
});

router.post('/', requireAuth, async (req, res) => {
  const { shippingAddress, paymentMethod, lines } = req.body || {};
  if (!shippingAddress || !paymentMethod || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'Invalid order payload.' });
  }

  const products = await prisma.product.findMany();
  const productMap = new Map(products.map((row) => [row.id, row]));

  let total = 0;
  for (const line of lines) {
    const product = productMap.get(line.productId);
    if (!product || !product.isActive) {
      return res.status(400).json({ error: 'Product unavailable.' });
    }
    if (product.stock < line.quantity) {
      return res.status(400).json({ error: 'Insufficient stock.' });
    }
    total += product.price * line.quantity;
  }

  const orderId = `ORD-${Date.now()}`;

  await prisma.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id: orderId,
        customerId: req.user.id,
        shippingAddress,
        paymentMethod,
        total,
        status: 'pending',
      },
    });

    for (const line of lines) {
      const product = productMap.get(line.productId);
      await tx.orderLine.create({
        data: {
          orderId,
          productId: product.id,
          productName: product.name,
          quantity: line.quantity,
          unitPrice: product.price,
        },
      });

      await tx.product.update({
        where: { id: product.id },
        data: { stock: product.stock - line.quantity },
      });
      productMap.set(product.id, {
        ...product,
        stock: product.stock - line.quantity,
      });
    }
  });

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });

  return res.status(201).json(mapOrder(order));
});

router.patch('/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  const { status } = req.body || {};
  const allowed = new Set(['pending', 'processing', 'shipped', 'delivered', 'cancelled']);
  if (!allowed.has(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { status },
    include: { customer: true },
  });
  return res.json(mapOrder(order));
});

router.get('/:id/lines', requireAuth, async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
  });
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (req.user.role !== 'admin' && order.customerId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const lines = await prisma.orderLine.findMany({
    where: { orderId: req.params.id },
  });

  return res.json(
    lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      subtotal: line.unitPrice * line.quantity,
    }))
  );
});

function mapOrder(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    customerId: row.customerId,
    customerEmail: row.customer?.email ?? '',
    shippingAddress: row.shippingAddress,
    paymentMethod: row.paymentMethod,
    total: row.total,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export default router;
