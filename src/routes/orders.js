import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  OrderValidationError,
  commitOrderDraft,
  mapOrder,
  prepareOrderDraft,
} from '../services/order_checkout.js';

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
  try {
    const draft = await prepareOrderDraft({
      customerId: req.user.id,
      customerEmail: req.user.email,
      shippingAddress: req.body?.shippingAddress,
      paymentMethod: req.body?.paymentMethod,
      lines: req.body?.lines,
      couponCode: req.body?.couponCode,
      shippingLatitude: req.body?.shippingLatitude,
      shippingLongitude: req.body?.shippingLongitude,
      shippingPlaceLabel: req.body?.shippingPlaceLabel,
    });

    const order = await commitOrderDraft(draft);
    return res.status(201).json(mapOrder(order));
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }
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

router.patch('/:id/tracking', requireAuth, requireRole('admin'), async (req, res) => {
  const { trackingNumber, trackingCarrier, trackingStatus } = req.body || {};
  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: {
      trackingNumber: trackingNumber?.trim() || null,
      trackingCarrier: trackingCarrier?.trim() || null,
      trackingStatus: trackingStatus?.trim() || null,
      trackingUpdatedAt: new Date(),
    },
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
      discountPercent: line.discountPercent ?? 0,
      subtotal: line.unitPrice * line.quantity,
    }))
  );
});

export default router;
