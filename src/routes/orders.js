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
  const { shippingAddress, paymentMethod, lines, couponCode } = req.body || {};
  const shippingPlaceLabel =
    req.body?.shippingPlaceLabel?.toString().trim() || null;
  const shippingLatitude = parseCoordinate(req.body?.shippingLatitude);
  const shippingLongitude = parseCoordinate(req.body?.shippingLongitude);
  if (!shippingAddress || !paymentMethod || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'Invalid order payload.' });
  }
  if ((shippingLatitude === null) !== (shippingLongitude === null)) {
    return res.status(400).json({
      error: 'Shipping latitude and longitude must be provided together.',
    });
  }
  if (
    (shippingLatitude !== null &&
      (!Number.isFinite(shippingLatitude) ||
        shippingLatitude < -90 ||
        shippingLatitude > 90)) ||
    (shippingLongitude !== null &&
      (!Number.isFinite(shippingLongitude) ||
        shippingLongitude < -180 ||
        shippingLongitude > 180))
  ) {
    return res.status(400).json({ error: 'Invalid shipping coordinates.' });
  }

  let coupon = null;
  if (couponCode) {
    coupon = await prisma.coupon.findUnique({
      where: { code: couponCode.toString().trim().toUpperCase() },
    });
    if (!coupon || !coupon.isActive || !isCouponUsable(coupon, req.user.email)) {
      return res.status(400).json({ error: 'Invalid coupon.' });
    }

    const existingRedemption = await prisma.couponRedemption.findUnique({
      where: {
        couponId_userId: {
          couponId: coupon.id,
          userId: req.user.id,
        },
      },
    });
    if (existingRedemption) {
      return res.status(400).json({
        error: 'You have already used this coupon.',
      });
    }
  }

  const productIds = [...new Set(lines.map((line) => line.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
  });
  const productMap = new Map(products.map((row) => [row.id, row]));

  let subtotal = 0;
  for (const line of lines) {
    const product = productMap.get(line.productId);
    if (!product || !product.isActive) {
      return res.status(400).json({ error: 'Product unavailable.' });
    }
    if (product.stock < line.quantity) {
      return res.status(400).json({ error: 'Insufficient stock.' });
    }
    const now = new Date();
    const start = product.discountStart ? new Date(product.discountStart) : null;
    const end = product.discountEnd ? new Date(product.discountEnd) : null;
    const isActive =
      (product.discountPercent ?? 0) > 0 &&
      (!start || start <= now) &&
      (!end || end >= now);
    const discountPercent = isActive
      ? Number(product.discountPercent ?? 0) || 0
      : 0;
    const priceAfterDiscount = product.price * (1 - discountPercent / 100);
    subtotal += priceAfterDiscount * line.quantity;
  }

  let couponDiscount = 0;
  if (coupon) {
    if (coupon.type === 'percent') {
      couponDiscount = subtotal * (coupon.value / 100);
    } else {
      couponDiscount = coupon.value;
    }
  }
  const total = Math.max(0, subtotal - couponDiscount);

  const orderId = `ORD-${Date.now()}`;

  const orderLineData = [];
  const stockUpdates = [];

  for (const line of lines) {
    const product = productMap.get(line.productId);
    const now = new Date();
    const start = product.discountStart
      ? new Date(product.discountStart)
      : null;
    const end = product.discountEnd ? new Date(product.discountEnd) : null;
    const isActive =
      (product.discountPercent ?? 0) > 0 &&
      (!start || start <= now) &&
      (!end || end >= now);
    const discountPercent = isActive
      ? Number(product.discountPercent ?? 0) || 0
      : 0;
    const priceAfterDiscount = product.price * (1 - discountPercent / 100);

    orderLineData.push({
      orderId,
      productId: product.id,
      productName: product.name,
      quantity: line.quantity,
      unitPrice: priceAfterDiscount,
      discountPercent,
    });

    const nextStock = product.stock - line.quantity;
    stockUpdates.push(
      prisma.product.update({
        where: { id: product.id },
        data: { stock: nextStock },
      })
    );
    productMap.set(product.id, {
      ...product,
      stock: nextStock,
    });
  }

  const operations = [
    prisma.order.create({
      data: {
        id: orderId,
        customerId: req.user.id,
        shippingAddress,
        shippingLatitude,
        shippingLongitude,
        shippingPlaceLabel,
        paymentMethod,
        total,
        status: 'pending',
        couponCode: coupon?.code ?? null,
        couponType: coupon?.type ?? null,
        couponValue: coupon?.value ?? null,
        couponDiscount,
      },
    }),
    ...(coupon
      ? [
          prisma.couponRedemption.create({
            data: {
              couponId: coupon.id,
              userId: req.user.id,
              orderId,
            },
          }),
        ]
      : []),
    prisma.orderLine.createMany({
      data: orderLineData,
    }),
    ...stockUpdates,
  ];

  try {
    await prisma.$transaction(operations);
  } catch (error) {
    if (error?.code === 'P2002' && coupon) {
      return res.status(400).json({ error: 'You have already used this coupon.' });
    }
    throw error;
  }

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

function mapOrder(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    customerId: row.customerId,
    customerEmail: row.customer?.email ?? '',
    customerFirstName: row.customer?.firstName ?? null,
    customerLastName: row.customer?.lastName ?? null,
    customerProfileImageUrl: row.customer?.profileImageUrl ?? null,
    shippingAddress: row.shippingAddress,
    shippingLatitude: row.shippingLatitude ?? null,
    shippingLongitude: row.shippingLongitude ?? null,
    shippingPlaceLabel: row.shippingPlaceLabel ?? null,
    paymentMethod: row.paymentMethod,
    total: row.total,
    status: row.status,
    createdAt: row.createdAt,
    trackingNumber: row.trackingNumber ?? null,
    trackingCarrier: row.trackingCarrier ?? null,
    trackingStatus: row.trackingStatus ?? null,
    trackingUpdatedAt: row.trackingUpdatedAt ?? null,
    couponCode: row.couponCode ?? null,
    couponType: row.couponType ?? null,
    couponValue: row.couponValue ?? null,
    couponDiscount: row.couponDiscount ?? null,
  };
}

function parseCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isCouponUsable(coupon, email) {
  const now = new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    return false;
  }
  if (coupon.endsAt && new Date(coupon.endsAt) < now) {
    return false;
  }
  if (coupon.audience === 'user' && coupon.userEmail !== email) {
    return false;
  }
  return true;
}

export default router;
