import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  checkTransaction,
  createQrPayment,
  createTranId,
  getAbaConfig,
  isFailureGatewayStatus,
  isPaidGatewayStatus,
  normalizeGatewayStatus,
  toAbaError,
  verifyCallbackSignature,
} from '../services/aba_payway.js';
import {
  OrderValidationError,
  commitOrderDraft,
  prepareOrderDraft,
  releaseOrderInventory,
} from '../services/order_checkout.js';

const router = Router();

function resolvePublicBaseUrl(req) {
  const explicitBaseUrl = (
    process.env.BASE_URL ??
    process.env.SERVER_PUBLIC_URL ??
    ''
  )
    .trim()
    .replace(/\/$/, '');

  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const forwardedProto = req
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();
  const forwardedHost = req
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host')?.trim();

  if (!host) {
    return '';
  }

  return `${protocol}://${host}`.replace(/\/$/, '');
}

router.post('/create', requireAuth, async (req, res) => {
  try {
    const {
      orderId,
      amount,
      currency = 'USD',
      shippingAddress,
      lines,
      couponCode,
      shippingLatitude,
      shippingLongitude,
      shippingPlaceLabel,
      firstName,
      lastName,
      email,
      phone,
    } = req.body ?? {};

    const publicBaseUrl = resolvePublicBaseUrl(req);
    let order = null;
    let resolvedOrderId = orderId?.toString().trim() || null;
    let resolvedAmount = null;
    const normalizedCurrency =
      currency?.toString().trim().toUpperCase() || 'USD';

    if (resolvedOrderId) {
      order = await prisma.order.findUnique({
        where: { id: resolvedOrderId },
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found.' });
      }

      if (req.user.role !== 'admin' && order.customerId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (order.paymentStatus === 'paid') {
        return res.status(409).json({ error: 'Order is already paid.' });
      }

      if (order.status === 'cancelled') {
        return res.status(409).json({
          error:
            'This order can no longer be paid. Please create a new checkout.',
        });
      }

      resolvedAmount = Number(order.paymentAmount ?? order.total);
      ensureAmountMatches(amount, resolvedAmount);
    } else {
      const draft = await prepareOrderDraft({
        customerId: req.user.id,
        customerEmail: req.user.email,
        shippingAddress,
        paymentMethod: 'ABA Pay',
        lines,
        couponCode,
        shippingLatitude,
        shippingLongitude,
        shippingPlaceLabel,
      });

      resolvedOrderId = draft.orderId;
      resolvedAmount = Number(draft.total);
      ensureAmountMatches(amount, resolvedAmount);

      const tranId = createTranId(draft.orderId);

      console.log('🧾 ORDER TOTAL:', resolvedAmount);
      console.log('🧾 ORDER ID:', resolvedOrderId);

      const qrPayment = await createQrPayment({
        tranId,
        amount: Number(draft.total).toFixed(2),
        currency: normalizedCurrency,
        firstName,
        lastName,
        email: email ?? req.user.email,
        phone,
        returnParams: draft.orderId,
        baseUrl: publicBaseUrl,
      });

      order = await commitOrderDraft(draft, {
        payment: {
          tranId: qrPayment.tranId,
          gateway: 'ABA_PAYWAY',
          status: 'pending',
          amount: Number(draft.total),
          currency: normalizedCurrency,
          expiresAt: qrPayment.expiresAt,
        },
      });

      return res.status(201).json({
        orderId: order.id,
        tran_id: qrPayment.tranId,
        qrImage: qrPayment.qrImage,
        qrString: qrPayment.qrString,
        deeplink: qrPayment.deeplink,
        amount: Number(qrPayment.amount).toFixed(2),
        currency: qrPayment.currency,
        expiresAt: qrPayment.expiresAt.toISOString(),
        lifetimeMinutes: getAbaConfig().qrLifetimeMinutes,
      });
    }

    let tranId = order.tranId;

    if (!tranId) {
      tranId = createTranId(order.id);
    }

    const qrPayment = await createQrPayment({
      tranId,
      amount: Number(resolvedAmount).toFixed(2),
      currency: order.paymentCurrency ?? normalizedCurrency,
      firstName,
      lastName,
      email: email ?? req.user.email,
      phone,
      returnParams: order.id,
      baseUrl: publicBaseUrl,
    });

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        tranId: qrPayment.tranId,
        paymentGateway: 'ABA_PAYWAY',
        paymentStatus: 'pending',
        paymentAmount: Number(resolvedAmount),
        paymentCurrency: order.paymentCurrency ?? normalizedCurrency,
        paymentExpiresAt: qrPayment.expiresAt,
        paymentPaidAt: null,
        paymentVerifiedAt: null,
        paymentLastCheckedAt: null,
        paymentCallbackReceivedAt: null,
        paymentCallbackStatus: null,
        paymentApprovalCode: null,
        paymentFailureReason: null,
      },
    });

    return res.json({
      orderId: updatedOrder.id,
      tran_id: qrPayment.tranId,
      qrImage: qrPayment.qrImage,
      qrString: qrPayment.qrString,
      deeplink: qrPayment.deeplink,
      amount: Number(qrPayment.amount).toFixed(2),
      currency: qrPayment.currency,
      expiresAt: qrPayment.expiresAt.toISOString(),
      lifetimeMinutes: getAbaConfig().qrLifetimeMinutes,
    });
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    if (error?.statusCode || error?.isAxiosError || error?.response) {
      const abaError = error?.statusCode
        ? error
        : toAbaError(error, 'Unable to create ABA payment.');
      console.error('[ABA] create payment error:', abaError);
      return res.status(abaError.statusCode).json({
        error: abaError.message,
        code: abaError.code,
        details: abaError.details,
      });
    }

    console.error('[ABA] create payment error:', error);
    return res.status(500).json({ error: 'Failed to create payment.' });
  }
});

router.post('/callback', async (req, res) => {
  const payload = req.body ?? {};
  const tranId = payload.tran_id?.toString().trim();
  const callbackStatus = payload.status?.toString() ?? null;

  try {
    const config = getAbaConfig();
    const signature = req.get('x-payway-hmac-sha512') ?? '';

    if (!verifyCallbackSignature(payload, signature, config.apiKey)) {
      return res.status(401).json({ error: 'Invalid ABA callback signature.' });
    }

    console.info('[ABA] callback received', {
      tranId: tranId ?? null,
      status: callbackStatus,
      apv: payload.apv ?? null,
      receivedAt: new Date().toISOString(),
    });

    if (!tranId) {
      return res.status(400).json({ error: 'tran_id is required.' });
    }

    const order = await prisma.order.findUnique({
      where: { tranId },
    });

    if (!order) {
      console.warn('[ABA] callback received for unknown transaction', { tranId });
      return res.status(200).json({ received: true, verified: false });
    }

    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentCallbackReceivedAt: new Date(),
        paymentCallbackStatus: callbackStatus,
      },
    });

    const verification = await verifyAndPersistOrderPayment(order.id, {
      callbackStatus,
    });

    return res.status(200).json({
      received: true,
      verified: verification.status === 'PAID',
      status: verification.status,
      tran_id: tranId,
    });
  } catch (error) {
    if (error?.statusCode || error?.isAxiosError || error?.response) {
      const abaError = error?.statusCode
        ? error
        : toAbaError(error, 'Failed to verify ABA callback.');
      console.error('[ABA] callback verification error:', abaError);
      return res.status(202).json({
        received: true,
        verified: false,
        error: abaError.message,
        tran_id: tranId ?? null,
      });
    }

    console.error('[ABA] callback error:', error);
    return res.status(500).json({ error: 'Failed to process callback.' });
  }
});

router.get('/status/:tranId', requireAuth, async (req, res) => {
  try {
    const tranId = req.params.tranId?.toString().trim();
    if (!tranId) {
      return res.status(400).json({ error: 'tran_id is required.' });
    }

    const order = await prisma.order.findUnique({
      where: { tranId },
    });

    if (!order) {
      return res.status(404).json({ error: 'Payment not found.' });
    }

    if (req.user.role !== 'admin' && order.customerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const payload = await verifyAndPersistOrderPayment(order.id);
    return res.json(payload);
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    if (error?.statusCode || error?.isAxiosError || error?.response) {
      const abaError = error?.statusCode
        ? error
        : toAbaError(error, 'Unable to verify ABA payment.');
      console.error('[ABA] status check error:', abaError);
      return res.status(abaError.statusCode).json({
        error: abaError.message,
        code: abaError.code,
        details: abaError.details,
      });
    }

    console.error('[ABA] status check error:', error);
    return res.status(500).json({ error: 'Failed to fetch payment status.' });
  }
});

async function verifyAndPersistOrderPayment(orderId, { callbackStatus } = {}) {
  let order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: true },
  });

  if (!order) {
    throw new OrderValidationError(404, 'Order not found.');
  }

  if (!order.tranId) {
    throw new OrderValidationError(400, 'Order has no active ABA transaction.');
  }

  const now = new Date();

  if (order.paymentStatus === 'paid') {
    return buildStatusPayload(order);
  }

  if (order.paymentExpiresAt && now > order.paymentExpiresAt) {
    order = await markOrderPaymentFailed(
      order,
      'expired',
      'QR_EXPIRED',
      callbackStatus,
      now,
    );
    return buildStatusPayload(order);
  }

  const verification = await checkTransaction(order.tranId);
  const gatewayCode = verification.status?.code?.toString() ?? '';
  const gatewayStatus = normalizeGatewayStatus(
    verification.data?.payment_status ?? callbackStatus,
  );

  console.log('ABA raw checkTransaction data:', verification.data);

  const isPaid =
    (gatewayCode === '0' || gatewayCode === '00') &&
    isPaidGatewayStatus(gatewayStatus);

  let amountMatches = true;
  let currencyMatches = true;

  if (isPaid) {
    const verifiedAmountRaw = toNumber(
      verification.data?.payment_amount ??
        verification.data?.original_amount ??
        verification.data?.amount ??
        verification.data?.total_amount,
    );

    const expectedAmount =
      Math.round(Number(order.paymentAmount ?? order.total) * 100) / 100;

    const verifiedAmount =
      verifiedAmountRaw !== null
        ? Math.round(Number(verifiedAmountRaw) * 100) / 100
        : null;

    const verifiedCurrency =
      verification.data?.payment_currency?.toString().trim().toUpperCase() ||
      verification.data?.original_currency?.toString().trim().toUpperCase() ||
      verification.data?.currency?.toString().trim().toUpperCase() ||
      null;

    console.log('ABA payment_amount:', verification.data?.payment_amount);
    console.log('ABA original_amount:', verification.data?.original_amount);
    console.log('ABA total_amount:', verification.data?.total_amount);
    console.log('ABA payment_currency:', verification.data?.payment_currency);
    console.log('EXPECTED:', expectedAmount);
    console.log('VERIFIED:', verifiedAmount);
    console.log('VERIFIED CURRENCY:', verifiedCurrency);

    amountMatches =
      verifiedAmount !== null &&
      Math.abs(expectedAmount - verifiedAmount) < 0.01;

    currencyMatches =
      !order.paymentCurrency ||
      verifiedCurrency === order.paymentCurrency;
  }

  if (isPaid && amountMatches && currencyMatches) {
    order = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'paid',
        paymentPaidAt: order.paymentPaidAt ?? now,
        paymentVerifiedAt: now,
        paymentLastCheckedAt: now,
        paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
        paymentApprovalCode:
          verification.data?.apv?.toString() ?? order.paymentApprovalCode,
        paymentFailureReason: null,
      },
      include: { lines: true },
    });

    return buildStatusPayload(order, gatewayStatus);
  }

  if (isPaid && !amountMatches) {
    order = await markOrderPaymentFailed(
      order,
      'failed',
      'AMOUNT_MISMATCH',
      callbackStatus,
      now,
    );
    return buildStatusPayload(order, gatewayStatus);
  }

  if (isPaid && !currencyMatches) {
    order = await markOrderPaymentFailed(
      order,
      'failed',
      'CURRENCY_MISMATCH',
      callbackStatus,
      now,
    );
    return buildStatusPayload(order, gatewayStatus);
  }

  if (
    (gatewayCode === '0' || gatewayCode === '00') &&
    isFailureGatewayStatus(gatewayStatus)
  ) {
    order = await markOrderPaymentFailed(
      order,
      gatewayStatus === 'EXPIRED' ? 'expired' : 'failed',
      gatewayStatus || 'PAYMENT_FAILED',
      callbackStatus,
      now,
    );
    return buildStatusPayload(order, gatewayStatus);
  }

  order = await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentLastCheckedAt: now,
      paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
    },
    include: { lines: true },
  });

  return buildStatusPayload(order, gatewayStatus);
}

async function markOrderPaymentFailed(
  order,
  paymentStatus,
  reason,
  callbackStatus,
  checkedAt,
) {
  if (order.status !== 'cancelled') {
    await releaseOrderInventory(order.id);
  }

  return prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus,
      paymentVerifiedAt: checkedAt,
      paymentLastCheckedAt: checkedAt,
      paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
      paymentFailureReason: reason,
    },
    include: { lines: true },
  });
}

function buildStatusPayload(order, gatewayStatus = null) {
  return {
    orderId: order.id,
    tran_id: order.tranId,
    status: toClientStatus(order.paymentStatus),
    paymentStatus: String(order.paymentStatus ?? 'pending').toUpperCase(),
    gatewayStatus: gatewayStatus ?? null,
    amount: Number(order.paymentAmount ?? order.total).toFixed(2),
    currency: order.paymentCurrency ?? 'USD',
    expiresAt: order.paymentExpiresAt?.toISOString() ?? null,
    paidAt: order.paymentPaidAt?.toISOString() ?? null,
    failureReason: order.paymentFailureReason ?? null,
  };
}

function ensureAmountMatches(requestedAmount, expectedAmount) {
  if (
    requestedAmount === undefined ||
    requestedAmount === null ||
    requestedAmount === ''
  ) {
    return;
  }

  const parsed = toNumber(requestedAmount);
  if (parsed === null || !numbersMatch(parsed, expectedAmount)) {
    throw new OrderValidationError(
      400,
      'Amount does not match the calculated order total.',
    );
  }
}

function toClientStatus(paymentStatus) {
  if (paymentStatus === 'paid') {
    return 'PAID';
  }

  if (paymentStatus === 'failed' || paymentStatus === 'expired') {
    return 'FAILED';
  }

  return 'PENDING';
}

function numbersMatch(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.001;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default router;


// import { Router } from 'express';

// import prisma from '../db.js';
// import { requireAuth } from '../middleware/auth.js';
// import {
//   checkTransaction,
//   createQrPayment,
//   createTranId,
//   getAbaConfig,
//   isFailureGatewayStatus,
//   isPaidGatewayStatus,
//   normalizeGatewayStatus,
//   toAbaError,
//   verifyCallbackSignature,
// } from '../services/aba_payway.js';
// import {
//   OrderValidationError,
//   commitOrderDraft,
//   prepareOrderDraft,
//   releaseOrderInventory,
// } from '../services/order_checkout.js';

// const router = Router();

// router.post('/create', requireAuth, async (req, res) => {
//   try {
//     const {
//       orderId,
//       amount,
//       currency = 'USD',
//       shippingAddress,
//       lines,
//       couponCode,
//       shippingLatitude,
//       shippingLongitude,
//       shippingPlaceLabel,
//       firstName,
//       lastName,
//       email,
//       phone,
//     } = req.body ?? {};

//     let order = null;
//     let resolvedOrderId = orderId?.toString().trim() || null;
//     let resolvedAmount = null;
//     const normalizedCurrency = currency?.toString().trim().toUpperCase() || 'USD';

//     if (resolvedOrderId) {
//       order = await prisma.order.findUnique({
//         where: { id: resolvedOrderId },
//       });

//       if (!order) {
//         return res.status(404).json({ error: 'Order not found.' });
//       }

//       if (req.user.role !== 'admin' && order.customerId !== req.user.id) {
//         return res.status(403).json({ error: 'Forbidden' });
//       }

//       if (order.paymentStatus === 'paid') {
//         return res.status(409).json({ error: 'Order is already paid.' });
//       }

//       if (order.status === 'cancelled') {
//         return res.status(409).json({
//           error: 'This order can no longer be paid. Please create a new checkout.',
//         });
//       }

//       resolvedAmount = Number(order.paymentAmount ?? order.total);
//       ensureAmountMatches(amount, resolvedAmount);
//     } else {
//       const draft = await prepareOrderDraft({
//         customerId: req.user.id,
//         customerEmail: req.user.email,
//         shippingAddress,
//         paymentMethod: 'ABA Pay',
//         lines,
//         couponCode,
//         shippingLatitude,
//         shippingLongitude,
//         shippingPlaceLabel,
//       });

//       resolvedOrderId = draft.orderId;
//       resolvedAmount = draft.total;
//       ensureAmountMatches(amount, resolvedAmount);

//       let tranId = createTranId(draft.orderId);

//       console.log("🧾 ORDER TOTAL:", resolvedAmount);
//       console.log("🧾 ORDER ID:", resolvedOrderId);
//       const qrPayment = await createQrPayment({
//         tranId: tranId,
//         amount: Number(draft.total),
//         currency: normalizedCurrency,
//         firstName,
//         lastName,
//         email: email ?? req.user.email,
//         phone,
//         returnParams: draft.orderId,
//       });

//       order = await commitOrderDraft(draft, {
//         payment: {
//           tranId: qrPayment.tranId,
//           gateway: 'ABA_PAYWAY',
//           status: 'pending',
//           amount: Number(draft.total),
//           currency: normalizedCurrency,
//           expiresAt: qrPayment.expiresAt,
//         },
//       });

//       return res.status(201).json({
//         orderId: order.id,
//         tran_id: qrPayment.tranId,
//         qrImage: qrPayment.qrImage,
//         qrString: qrPayment.qrString,
//         deeplink: qrPayment.deeplink,
//         amount: Math.round(Number(qrPayment.amount) * 100) / 100,
//         currency: qrPayment.currency,
//         expiresAt: qrPayment.expiresAt.toISOString(),
//         lifetimeMinutes: getAbaConfig().qrLifetimeMinutes,
//       });
//     }
//     // subtotal = Math.round(subtotal * 100) / 100;

//     let tranId = order.tranId;

//     if (!tranId) {
//       tranId = createTranId(order.id);
//     }

//     const qrPayment = await createQrPayment({
//       tranId: tranId,
//       amount: Number(resolvedAmount).toFixed(2),
//       currency: order.paymentCurrency ?? normalizedCurrency,
//       firstName,
//       lastName,
//       email: email ?? req.user.email,
//       phone,
//       returnParams: order.id,
//     });

//     const updatedOrder = await prisma.order.update({
//       where: { id: order.id },
//       data: {
//         tranId: qrPayment.tranId,
//         paymentGateway: 'ABA_PAYWAY',
//         paymentStatus: 'pending',
//         paymentAmount: Number(resolvedAmount),
//         paymentCurrency: order.paymentCurrency ?? normalizedCurrency,
//         paymentExpiresAt: qrPayment.expiresAt,
//         paymentPaidAt: null,
//         paymentVerifiedAt: null,
//         paymentLastCheckedAt: null,
//         paymentCallbackReceivedAt: null,
//         paymentCallbackStatus: null,
//         paymentApprovalCode: null,
//         paymentFailureReason: null,
//       },
//     });

//     return res.json({
//       orderId: updatedOrder.id,
//       tran_id: qrPayment.tranId,
//       qrImage: qrPayment.qrImage,
//       qrString: qrPayment.qrString,
//       deeplink: qrPayment.deeplink,
//       amount: Number(qrPayment.amount).toFixed(2),
//       currency: qrPayment.currency,
//       expiresAt: qrPayment.expiresAt.toISOString(),
//       lifetimeMinutes: getAbaConfig().qrLifetimeMinutes,
//     });
//   } catch (error) {
//     if (error instanceof OrderValidationError) {
//       return res.status(error.statusCode).json({ error: error.message });
//     }

//     if (error?.statusCode || error?.isAxiosError || error?.response) {
//       const abaError = error?.statusCode
//         ? error
//         : toAbaError(error, 'Unable to create ABA payment.');
//       console.error('[ABA] create payment error:', abaError);
//       return res.status(abaError.statusCode).json({
//         error: abaError.message,
//         code: abaError.code,
//         details: abaError.details,
//       });
//     }

//     console.error('[ABA] create payment error:', error);
//     return res.status(500).json({ error: 'Failed to create payment.' });
//   }
// });

// router.post('/callback', async (req, res) => {
//   const payload = req.body ?? {};
//   const tranId = payload.tran_id?.toString().trim();
//   const callbackStatus = payload.status?.toString() ?? null;

//   try {
//     const config = getAbaConfig();
//     const signature = req.get('x-payway-hmac-sha512') ?? '';
//     if (!verifyCallbackSignature(payload, signature, config.apiKey)) {
//       return res.status(401).json({ error: 'Invalid ABA callback signature.' });
//     }

//     console.info('[ABA] callback received', {
//       tranId: tranId ?? null,
//       status: callbackStatus,
//       apv: payload.apv ?? null,
//       receivedAt: new Date().toISOString(),
//     });

//     if (!tranId) {
//       return res.status(400).json({ error: 'tran_id is required.' });
//     }

//     const order = await prisma.order.findUnique({
//       where: { tranId },
//     });

//     if (!order) {
//       console.warn('[ABA] callback received for unknown transaction', { tranId });
//       return res.status(200).json({ received: true, verified: false });
//     }

//     await prisma.order.update({
//       where: { id: order.id },
//       data: {
//         paymentCallbackReceivedAt: new Date(),
//         paymentCallbackStatus: callbackStatus,
//       },
//     });

//     const verification = await verifyAndPersistOrderPayment(order.id, {
//       callbackStatus,
//     });

//     return res.status(200).json({
//       received: true,
//       verified: verification.status === 'PAID',
//       status: verification.status,
//       tran_id: tranId,
//     });
//   } catch (error) {
//     if (error?.statusCode || error?.isAxiosError || error?.response) {
//       const abaError = error?.statusCode
//         ? error
//         : toAbaError(error, 'Failed to verify ABA callback.');
//       console.error('[ABA] callback verification error:', abaError);
//       return res.status(202).json({
//         received: true,
//         verified: false,
//         error: abaError.message,
//         tran_id: tranId ?? null,
//       });
//     }

//     console.error('[ABA] callback error:', error);
//     return res.status(500).json({ error: 'Failed to process callback.' });
//   }
// });

// router.get('/status/:tranId', requireAuth, async (req, res) => {
//   try {
//     const tranId = req.params.tranId?.toString().trim();
//     if (!tranId) {
//       return res.status(400).json({ error: 'tran_id is required.' });
//     }

//     const order = await prisma.order.findUnique({
//       where: { tranId },
//     });

//     if (!order) {
//       return res.status(404).json({ error: 'Payment not found.' });
//     }

//     if (req.user.role !== 'admin' && order.customerId !== req.user.id) {
//       return res.status(403).json({ error: 'Forbidden' });
//     }

//     const payload = await verifyAndPersistOrderPayment(order.id);
//     return res.json(payload);
//   } catch (error) {
//     if (error instanceof OrderValidationError) {
//       return res.status(error.statusCode).json({ error: error.message });
//     }

//     if (error?.statusCode || error?.isAxiosError || error?.response) {
//       const abaError = error?.statusCode
//         ? error
//         : toAbaError(error, 'Unable to verify ABA payment.');
//       console.error('[ABA] status check error:', abaError);
//       return res.status(abaError.statusCode).json({
//         error: abaError.message,
//         code: abaError.code,
//         details: abaError.details,
//       });
//     }

//     console.error('[ABA] status check error:', error);
//     return res.status(500).json({ error: 'Failed to fetch payment status.' });
//   }
// });

// async function verifyAndPersistOrderPayment(orderId, { callbackStatus } = {}) {
//   let order = await prisma.order.findUnique({
//     where: { id: orderId },
//     include: { lines: true },
//   });

//   if (!order) {
//     throw new OrderValidationError(404, 'Order not found.');
//   }

//   if (!order.tranId) {
//     throw new OrderValidationError(400, 'Order has no active ABA transaction.');
//   }

//   const now = new Date();
//   if (order.paymentStatus === 'paid') {
//     return buildStatusPayload(order);
//   }

//   if (order.paymentExpiresAt && now > order.paymentExpiresAt) {
//     order = await markOrderPaymentFailed(
//       order,
//       'expired',
//       'QR_EXPIRED',
//       callbackStatus,
//       now,
//     );
//     return buildStatusPayload(order);
//   }

//   const verification = await checkTransaction(order.tranId);
// const gatewayCode = verification.status?.code?.toString() ?? '';
// const gatewayStatus = normalizeGatewayStatus(
//   verification.data?.payment_status ?? callbackStatus,
// );

// console.log("ABA raw checkTransaction data:", verification.data);

// const isPaid =
//   (gatewayCode === '0' || gatewayCode === '00') &&
//   isPaidGatewayStatus(gatewayStatus);

// // Only verify amount/currency after payment is actually approved
// let verifiedAmount = null;
// let verifiedCurrency = null;
// let amountMatches = true;
// let currencyMatches = true;

// if (isPaid) {
//   const verifiedAmountRaw = toNumber(
//     verification.data?.payment_amount ??
//     verification.data?.original_amount ??
//     verification.data?.amount ??
//     verification.data?.total_amount
//   );

//   const expectedAmount =
//     Math.round(Number(order.paymentAmount ?? order.total) * 100) / 100;

//   verifiedAmount =
//     verifiedAmountRaw !== null
//       ? Math.round(Number(verifiedAmountRaw) * 100) / 100
//       : null;

//   console.log("ABA payment_amount:", verification.data?.payment_amount);
//   console.log("ABA original_amount:", verification.data?.original_amount);
//   console.log("ABA total_amount:", verification.data?.total_amount);
//   console.log("ABA payment_currency:", verification.data?.payment_currency);
//   console.log("EXPECTED:", expectedAmount);
//   console.log("VERIFIED:", verifiedAmount);

//   const difference =
//     verifiedAmount === null
//       ? null
//       : Math.abs(expectedAmount - verifiedAmount);

//   amountMatches =
//     verifiedAmount !== null &&
//     difference < 0.01;

//   verifiedCurrency =
//     verification.data?.payment_currency?.toString().trim().toUpperCase() ||
//     verification.data?.currency?.toString().trim().toUpperCase() ||
//     verification.data?.original_currency?.toString().trim().toUpperCase() ||
//     null;

//   currencyMatches =
//     !order.paymentCurrency ||
//     verifiedCurrency === order.paymentCurrency;
// }

//   // const verification = await checkTransaction(order.tranId);
//   // const gatewayCode = verification.status?.code?.toString() ?? '';
//   // const gatewayStatus = normalizeGatewayStatus(
//   //   verification.data?.payment_status ?? callbackStatus,
//   // );

//   // // const verifiedAmountRaw = toNumber(
//   // //   verification.data?.total_amount ??
//   // //   verification.data?.payment_amount ??
//   // //   verification.data?.original_amount ??
//   // //   verification.data?.amount,
//   // // );

//   // const verifiedAmountRaw = toNumber(
//   //   verification.data?.payment_amount ??
//   //   verification.data?.original_amount ??
//   //   verification.data?.amount ??
//   //   verification.data?.total_amount
//   // );

//   // console.log("ABA raw checkTransaction data:", verification.data);
//   // console.log("ABA payment_amount:", verification.data?.payment_amount);
//   // console.log("ABA original_amount:", verification.data?.original_amount);
//   // console.log("ABA total_amount:", verification.data?.total_amount);
//   // console.log("ABA payment_currency:", verification.data?.payment_currency);

//   // const expectedAmount = Math.round(Number(order.paymentAmount ?? order.total) * 100) / 100;

//   // const verifiedAmount = verifiedAmountRaw !== null
//   //   ? Math.round(Number(verifiedAmountRaw) * 100) / 100
//   //   : null;

//   // // 🔍 Debug log (VERY IMPORTANT)
//   // console.log("EXPECTED:", expectedAmount);
//   // console.log("VERIFIED:", verifiedAmount);

//   // // ✅ Compare normalized values
//   // const difference = Math.abs(expectedAmount - verifiedAmount);

//   // const amountMatches =
//   // verifiedAmount === null ||
//   // difference <= 0.01;
//   // // const amountMatches = verifiedAmount === null || Math.abs(Number(expectedAmount) - Number(verifiedAmount)) < 0.01;

//   // // const verifiedAmount = toNumber(
//   // //   verification.data?.total_amount ??
//   // //     verification.data?.payment_amount ??
//   // //     verification.data?.original_amount ??
//   // //     verification.data?.amount,
//   // // );

//   // // const expectedAmount = Number(order.paymentAmount ?? order.total);
//   // // const amountMatches =
//   // //   verifiedAmount === null || numbersMatch(expectedAmount, verifiedAmount);
//   // const verifiedCurrency =
//   //   verification.data?.payment_currency?.toString().trim().toUpperCase() ||
//   //   verification.data?.currency?.toString().trim().toUpperCase() ||
//   //   null;

//   // const currencyMatches =
//   //   !verifiedCurrency ||
//   //   !order.paymentCurrency ||
//   //   verifiedCurrency === order.paymentCurrency;

//   // if (
//   //   (gatewayCode === '0' || gatewayCode === '00') &&
//   //   isPaidGatewayStatus(gatewayStatus) &&
//   //   amountMatches &&
//   //   currencyMatches
//   // ) {
//   if (isPaid && amountMatches && currencyMatches) {
//     order = await prisma.order.update({
//       where: { id: order.id },
//       data: {
//         paymentStatus: 'paid',
//         paymentPaidAt: order.paymentPaidAt ?? now,
//         paymentVerifiedAt: now,
//         paymentLastCheckedAt: now,
//         paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
//         paymentApprovalCode:
//           verification.data?.apv?.toString() ?? order.paymentApprovalCode,
//         paymentFailureReason: null,
//       },
//       include: { lines: true },
//     });

//     return buildStatusPayload(order, gatewayStatus);
//   }

//   if (isPaid && !amountMatches) {
//     order = await markOrderPaymentFailed(
//       order,
//       'failed',
//       'AMOUNT_MISMATCH',
//       callbackStatus,
//       now,
//     );
//     return buildStatusPayload(order, gatewayStatus);
//   }

//   if (!isPaid && !currencyMatches) {
//     order = await markOrderPaymentFailed(
//       order,
//       'failed',
//       'CURRENCY_MISMATCH',
//       callbackStatus,
//       now,
//     );
//     return buildStatusPayload(order, gatewayStatus);
//   }

//   if (
//     (gatewayCode === '0' || gatewayCode === '00') &&
//     isFailureGatewayStatus(gatewayStatus)
//   ) {
//     order = await markOrderPaymentFailed(
//       order,
//       gatewayStatus === 'EXPIRED' ? 'expired' : 'failed',
//       gatewayStatus || 'PAYMENT_FAILED',
//       callbackStatus,
//       now,
//     );
//     return buildStatusPayload(order, gatewayStatus);
//   }

//   order = await prisma.order.update({
//     where: { id: order.id },
//     data: {
//       paymentLastCheckedAt: now,
//       paymentVerifiedAt: gatewayCode === '0' || gatewayCode === '00' ? now : order.paymentVerifiedAt,
//       paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
//     },
//     include: { lines: true },
//   });

//   return buildStatusPayload(order, gatewayStatus);
// }

// async function markOrderPaymentFailed(
//   order,
//   paymentStatus,
//   reason,
//   callbackStatus,
//   checkedAt,
// ) {
//   if (order.status !== 'cancelled') {
//     await releaseOrderInventory(order.id);
//   }

//   return prisma.order.update({
//     where: { id: order.id },
//     data: {
//       paymentStatus,
//       paymentVerifiedAt: checkedAt,
//       paymentLastCheckedAt: checkedAt,
//       paymentCallbackStatus: callbackStatus ?? order.paymentCallbackStatus,
//       paymentFailureReason: reason,
//     },
//     include: { lines: true },
//   });
// }

// function buildStatusPayload(order, gatewayStatus = null) {
//   return {
//     orderId: order.id,
//     tran_id: order.tranId,
//     status: toClientStatus(order.paymentStatus),
//     paymentStatus: String(order.paymentStatus ?? 'pending').toUpperCase(),
//     gatewayStatus: gatewayStatus ?? null,
//     amount: Number(order.paymentAmount ?? order.total).toFixed(2),
//     currency: order.paymentCurrency ?? 'USD',
//     expiresAt: order.paymentExpiresAt?.toISOString() ?? null,
//     paidAt: order.paymentPaidAt?.toISOString() ?? null,
//     failureReason: order.paymentFailureReason ?? null,
//   };
// }

// function ensureAmountMatches(requestedAmount, expectedAmount) {
//   if (requestedAmount === undefined || requestedAmount === null || requestedAmount === '') {
//     return;
//   }

//   const parsed = toNumber(requestedAmount);
//   if (parsed === null || !numbersMatch(parsed, expectedAmount)) {
//     throw new OrderValidationError(
//       400,
//       'Amount does not match the calculated order total.',
//     );
//   }
// }

// function toClientStatus(paymentStatus) {
//   if (paymentStatus === 'paid') {
//     return 'PAID';
//   }

//   if (paymentStatus === 'failed' || paymentStatus === 'expired') {
//     return 'FAILED';
//   }

//   return 'PENDING';
// }

// function numbersMatch(left, right) {
//   return Math.abs(Number(left) - Number(right)) < 0.001;
// }

// function toNumber(value) {
//   if (value === undefined || value === null || value === '') {
//     return null;
//   }

//   const parsed = Number(value);
//   return Number.isFinite(parsed) ? parsed : null;
// }

// export default router;
