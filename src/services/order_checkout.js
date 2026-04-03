import crypto from 'node:crypto';

import prisma from '../db.js';
import { saveDeliveryLocation } from './delivery_locations.js';

export class OrderValidationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'OrderValidationError';
    this.statusCode = statusCode;
  }
}

export function parseCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function isCouponUsable(coupon, email) {
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

export function mapOrder(row) {
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
    tranId: row.tranId ?? null,
    paymentGateway: row.paymentGateway ?? null,
    paymentStatus: row.paymentStatus ?? 'pending',
    paymentAmount: row.paymentAmount ?? null,
    paymentCurrency: row.paymentCurrency ?? null,
    paymentExpiresAt: row.paymentExpiresAt ?? null,
    paymentPaidAt: row.paymentPaidAt ?? null,
    paymentVerifiedAt: row.paymentVerifiedAt ?? null,
    paymentLastCheckedAt: row.paymentLastCheckedAt ?? null,
    paymentCallbackReceivedAt: row.paymentCallbackReceivedAt ?? null,
    paymentCallbackStatus: row.paymentCallbackStatus ?? null,
    paymentApprovalCode: row.paymentApprovalCode ?? null,
    paymentFailureReason: row.paymentFailureReason ?? null,
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

export async function prepareOrderDraft({
  customerId,
  customerEmail,
  shippingAddress,
  paymentMethod,
  lines,
  couponCode,
  shippingLatitude,
  shippingLongitude,
  shippingPlaceLabel,
  orderId,
}) {
  const normalizedAddress = shippingAddress?.toString().trim() ?? '';
  const normalizedPaymentMethod = paymentMethod?.toString().trim() ?? '';
  const normalizedPlaceLabel = shippingPlaceLabel?.toString().trim() || null;
  const latitude = parseCoordinate(shippingLatitude);
  const longitude = parseCoordinate(shippingLongitude);

  if (
    !normalizedAddress ||
    !normalizedPaymentMethod ||
    !Array.isArray(lines) ||
    lines.length === 0
  ) {
    throw new OrderValidationError(400, 'Invalid order payload.');
  }

  if ((latitude === null) !== (longitude === null)) {
    throw new OrderValidationError(
      400,
      'Shipping latitude and longitude must be provided together.',
    );
  }

  if (
    (latitude !== null &&
      (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
    (longitude !== null &&
      (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))
  ) {
    throw new OrderValidationError(400, 'Invalid shipping coordinates.');
  }

  const normalizedLines = lines.map((line) => ({
    productId: line?.productId?.toString() ?? '',
    quantity: Number.parseInt(String(line?.quantity ?? ''), 10),
  }));

  if (
    normalizedLines.some(
      (line) =>
        !line.productId ||
        !Number.isInteger(line.quantity) ||
        line.quantity <= 0,
    )
  ) {
    throw new OrderValidationError(400, 'Invalid order lines.');
  }

  let coupon = null;
  const normalizedCouponCode = couponCode?.toString().trim().toUpperCase() || null;

  if (normalizedCouponCode) {
    coupon = await prisma.coupon.findUnique({
      where: { code: normalizedCouponCode },
    });

    if (!coupon || !coupon.isActive || !isCouponUsable(coupon, customerEmail)) {
      throw new OrderValidationError(400, 'Invalid coupon.');
    }

    const existingRedemption = await prisma.couponRedemption.findUnique({
      where: {
        couponId_userId: {
          couponId: coupon.id,
          userId: customerId,
        },
      },
    });

    if (existingRedemption) {
      throw new OrderValidationError(
        400,
        'You have already used this coupon.',
      );
    }
  }

  const productIds = [...new Set(normalizedLines.map((line) => line.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
  });
  const productMap = new Map(products.map((row) => [row.id, row]));

  let subtotal = 0;
  const orderLineData = [];
  const stockAdjustments = [];

  for (const line of normalizedLines) {
    const product = productMap.get(line.productId);
    if (!product || !product.isActive) {
      throw new OrderValidationError(400, 'Product unavailable.');
    }

    if (product.stock < line.quantity) {
      throw new OrderValidationError(400, 'Insufficient stock.');
    }

    const now = new Date();
    const discountStart = product.discountStart
      ? new Date(product.discountStart)
      : null;
    const discountEnd = product.discountEnd ? new Date(product.discountEnd) : null;
    const isDiscountActive =
      (product.discountPercent ?? 0) > 0 &&
      (!discountStart || discountStart <= now) &&
      (!discountEnd || discountEnd >= now);
    const discountPercent = isDiscountActive
      ? Number(product.discountPercent ?? 0) || 0
      : 0;
    const unitPrice = product.price * (1 - discountPercent / 100);

    // subtotal += unitPrice * line.quantity;
    const lineTotal = unitPrice * line.quantity;

    // optional debug
    console.log("🛒 LINE TOTAL RAW:", lineTotal);

    subtotal += lineTotal;

    console.log("🧮 SUBTOTAL RAW:", subtotal);
    subtotal = Math.round(subtotal * 100) / 100;
    console.log("✅ SUBTOTAL FIXED:", subtotal);
    orderLineData.push({
      productId: product.id,
      productName: product.name,
      quantity: line.quantity,
      unitPrice,
      discountPercent,
    });
    stockAdjustments.push({
      productId: product.id,
      nextStock: product.stock - line.quantity,
    });
  }

  let couponDiscount = 0;
  if (coupon) {
    if (coupon.type === 'percent') {
      // couponDiscount = subtotal * (coupon.value / 100);
      couponDiscount = Number((subtotal * (coupon.value / 100)).toFixed(2));
    } else {
      couponDiscount = coupon.value;
    }
  }

    
    // const total = Math.max(0, subtotal - couponDiscount);
    const rawTotal = Math.max(0, subtotal - couponDiscount);
    const total = Number((Math.round(rawTotal * 100) / 100).toFixed(2));

    // 🔥 CRITICAL FIX: normalize to 2 decimals
   

  return {
    orderId: orderId?.toString().trim() || createOrderId(),
    customerId,
    shippingAddress: normalizedAddress,
    shippingLatitude: latitude,
    shippingLongitude: longitude,
    shippingPlaceLabel: normalizedPlaceLabel,
    paymentMethod: normalizedPaymentMethod,
    total,
    coupon,
    couponDiscount,
    orderLineData,
    stockAdjustments,
  };
}

export async function commitOrderDraft(draft, { payment = {} } = {}) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          id: draft.orderId,
          customerId: draft.customerId,
          shippingAddress: draft.shippingAddress,
          shippingLatitude: draft.shippingLatitude,
          shippingLongitude: draft.shippingLongitude,
          shippingPlaceLabel: draft.shippingPlaceLabel,
          paymentMethod: draft.paymentMethod,
          total: Number(draft.total),
          status: payment.orderStatus ?? 'pending',
          tranId: payment.tranId ?? null,
          paymentGateway: payment.gateway ?? null,
          paymentStatus: payment.status ?? 'pending',
          paymentAmount: payment.amount ?? null,
          paymentCurrency: payment.currency ?? null,
          paymentExpiresAt: payment.expiresAt ?? null,
          paymentFailureReason: payment.failureReason ?? null,
          couponCode: draft.coupon?.code ?? null,
          couponType: draft.coupon?.type ?? null,
          couponValue: draft.coupon?.value ?? null,
          couponDiscount: draft.couponDiscount,
        },
      });

      if (draft.coupon) {
        await tx.couponRedemption.create({
          data: {
            couponId: draft.coupon.id,
            userId: draft.customerId,
            orderId: draft.orderId,
          },
        });
      }

      await tx.orderLine.createMany({
        data: draft.orderLineData.map((line) => ({
          orderId: draft.orderId,
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
        })),
      });

      for (const adjustment of draft.stockAdjustments) {
        await tx.product.update({
          where: { id: adjustment.productId },
          data: { stock: adjustment.nextStock },
        });
      }

      if (
        draft.shippingLatitude != null &&
        draft.shippingLongitude != null
      ) {
        await saveDeliveryLocation(
          {
            userId: draft.customerId,
            address: draft.shippingAddress,
            latitude: draft.shippingLatitude,
            longitude: draft.shippingLongitude,
            placeLabel: draft.shippingPlaceLabel,
            makeDefault: true,
          },
          tx,
        );
      }
    });
  } catch (error) {
    if (error?.code === 'P2002' && draft.coupon) {
      throw new OrderValidationError(
        400,
        'You have already used this coupon.',
      );
    }
    throw error;
  }

  return prisma.order.findUnique({
    where: { id: draft.orderId },
    include: { customer: true },
  });
}

export async function releaseOrderInventory(orderId) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });

  if (!order) {
    throw new OrderValidationError(404, 'Order not found.');
  }

  if (order.status === 'cancelled') {
    return order;
  }

  await prisma.$transaction(async (tx) => {
    for (const line of order.lines) {
      await tx.product.update({
        where: { id: line.productId },
        data: {
          stock: {
            increment: line.quantity,
          },
        },
      });
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: 'cancelled' },
    });
  });

  return prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });
}

function createOrderId() {
  return `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
