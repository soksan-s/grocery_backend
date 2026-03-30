import crypto from 'node:crypto';
import axios from 'axios';

const DEFAULT_QR_API_URL =
  'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr';

const DEFAULT_CHECK_API_URL =
  'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/check-transaction-2';

const GENERATE_QR_HASH_ORDER = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'first_name',
  'last_name',
  'email',
  'phone',
  'purchase_type',
  'payment_option',
  'callback_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'qr_image_template',
];

const PURCHASE_HASH_ORDER = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'shipping',
  'ctid',
  'pwt',
  'firstname',
  'lastname',
  'email',
  'phone',
  'type',
  'payment_option',
  'return_url',
  'cancel_url',
  'continue_success_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
];

export function getAbaConfig() {
  const baseUrl = (process.env.BASE_URL ?? process.env.SERVER_PUBLIC_URL ?? '')
    .trim()
    .replace(/\/$/, '');

  return {
    merchantId: (
      process.env.ABA_MERCHANT_ID ??
      process.env.PAYWAY_MERCHANT_ID ??
      ''
    ).trim(),

    apiKey: (
      process.env.ABA_API_KEY ??
      process.env.PAYWAY_PUBLIC_KEY ??
      ''
    ).trim(),

    purchaseUrl: (
      process.env.ABA_API_URL ??
      process.env.PAYWAY_QR_API_URL ??
      DEFAULT_QR_API_URL
    ).trim(),

    checkUrl: (
      process.env.ABA_CHECK_TRANSACTION_URL ??
      process.env.PAYWAY_CHECK_API_URL ??
      DEFAULT_CHECK_API_URL
    ).trim(),

    baseUrl,

    // Use ABA Pay mode for USD decimal amounts
    paymentOption: 'abapay',

    qrLifetimeMinutes: normalizeLifetime(
      process.env.ABA_QR_LIFETIME_MINUTES,
    ),

    qrTemplate: (
      process.env.ABA_QR_TEMPLATE ??
      'template3_color'
    ).trim(),
  };
}

export function assertAbaConfig(config = getAbaConfig()) {
  if (!config.merchantId || !config.apiKey) {
    throw new Error(
      'ABA PayWay is not configured. Set ABA_MERCHANT_ID and ABA_API_KEY.',
    );
  }

  if (!config.baseUrl) {
    throw new Error('BASE_URL is required for ABA callback delivery.');
  }

  return config;
}

export function getReqTime() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return (
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

export function createTranId(orderId) {
  const baseOrderId = String(orderId ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-6)
    .toUpperCase();

  const timestamp = Date.now().toString().slice(-6);
  const suffix = crypto.randomBytes(1).toString('hex').toUpperCase();

  return `KH${timestamp}${baseOrderId}${suffix}`;
}

export function verifyCallbackSignature(payload, receivedSignature, apiKey) {
  if (!receivedSignature) {
    return false;
  }

  const keys = Object.keys(payload ?? {}).sort();
  const body = keys.map((key) => serializeForHash(payload[key])).join('');

  const expected = crypto
    .createHmac('sha512', apiKey)
    .update(body)
    .digest('base64');

  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(String(receivedSignature), 'utf8');

  if (left.length === 0 || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export async function createQrPayment({
  tranId,
  amount,
  currency = 'USD',
  firstName,
  lastName,
  email,
  phone,
  returnParams,
}) {
  const config = assertAbaConfig();
  const reqTime = getReqTime();
  const normalizedCurrency = String(currency ?? 'USD').trim().toUpperCase();

  const isLegacyPurchaseEndpoint = /\/purchase$/i.test(config.purchaseUrl);

  const callbackUrl = Buffer.from(
    `${config.baseUrl}/api/payments/callback`,
    'utf8',
  ).toString('base64');

  const payload = isLegacyPurchaseEndpoint
    ? buildPurchasePayload({
        reqTime,
        merchantId: config.merchantId,
        tranId,
        amount,
        currency: normalizedCurrency,
        callbackUrl,
        paymentOption: config.paymentOption,
        firstName,
        lastName,
        email,
        phone,
        returnParams,
        apiKey: config.apiKey,
      })
    : buildGenerateQrPayload({
        reqTime,
        merchantId: config.merchantId,
        tranId,
        amount,
        currency: normalizedCurrency,
        callbackUrl,
        paymentOption: config.paymentOption,
        firstName,
        lastName,
        email,
        phone,
        returnParams,
        apiKey: config.apiKey,
        qrLifetimeMinutes: config.qrLifetimeMinutes,
        qrTemplate: config.qrTemplate,
      });

  const response = isLegacyPurchaseEndpoint
    ? await axios.post(config.purchaseUrl, toFormData(payload), {
        timeout: 20000,
      })
    : await axios.post(config.purchaseUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      });

  const data = response.data ?? {};
  const statusCode = data.status?.code?.toString() ?? '';

  if (statusCode !== '0' && statusCode !== '00') {
    throw toAbaError(data, 'ABA rejected the QR payment request.');
  }

  return {
    reqTime,
    tranId,
    amount: Number(data.amount ?? payload.amount),
    currency: data.currency ?? payload.currency,
    qrImage: data.qrImage ?? null,
    qrString: data.qrString ?? null,
    deeplink: data.abapay_deeplink ?? null,
    appStore: data.app_store ?? null,
    playStore: data.play_store ?? null,
    expiresAt: new Date(
      Date.now() + config.qrLifetimeMinutes * 60 * 1000,
    ),
    raw: data,
  };
}

export async function checkTransaction(tranId) {
  const config = assertAbaConfig();
  const reqTime = getReqTime();

  const payload = {
    req_time: reqTime,
    merchant_id: config.merchantId,
    tran_id: tranId,
    hash: crypto
      .createHmac('sha512', config.apiKey)
      .update(`${reqTime}${config.merchantId}${tranId}`)
      .digest('base64'),
  };

  const response = await axios.post(config.checkUrl, payload, {
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });

  return response.data ?? {};
}

export function normalizeGatewayStatus(status) {
  return String(status ?? '').trim().toUpperCase();
}

export function isPaidGatewayStatus(status) {
  const normalized = normalizeGatewayStatus(status);
  return (
    normalized === 'APPROVED' ||
    normalized === 'SUCCESS' ||
    normalized === 'PAID'
  );
}

export function isFailureGatewayStatus(status) {
  const normalized = normalizeGatewayStatus(status);
  return [
    'DECLINED',
    'FAILED',
    'REJECTED',
    'CANCELLED',
    'CANCELED',
    'VOIDED',
    'EXPIRED',
  ].includes(normalized);
}

export function toAbaError(errorOrBody, fallbackMessage) {
  if (errorOrBody?.isAxiosError) {
    const message =
      errorOrBody.response?.data?.status?.message ??
      errorOrBody.response?.data?.message ??
      errorOrBody.message ??
      fallbackMessage;

    const statusCode = errorOrBody.response?.status ?? 502;
    const status = errorOrBody.response?.data?.status;

    return {
      statusCode,
      code: status?.code?.toString() ?? null,
      message: formatDomainWhitelistHint(message, status?.code),
      details: errorOrBody.response?.data ?? null,
    };
  }

  const status = errorOrBody?.status;

  return {
    statusCode: 422,
    code: status?.code?.toString() ?? null,
    message: formatDomainWhitelistHint(
      status?.message ?? fallbackMessage,
      status?.code,
    ),
    details: errorOrBody ?? null,
  };
}

function createQrHash(payload, apiKey) {
  const body = GENERATE_QR_HASH_ORDER
    .map((key) => serializeForHash(payload[key]))
    .join('');

  return crypto.createHmac('sha512', apiKey).update(body).digest('base64');
}

function createPurchaseHash(payload, apiKey) {
  const body = PURCHASE_HASH_ORDER
    .map((key) => serializeForHash(payload[key]))
    .join('');

  return crypto.createHmac('sha512', apiKey).update(body).digest('base64');
}

function serializeForHash(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeLifetime(value) {
  const parsed = Number.parseInt(String(value ?? '3'), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
  }

  return parsed;
}

function formatDomainWhitelistHint(message, code) {
  if (String(code ?? '') !== '6') {
    return message;
  }

  return `${message} Ask ABA to whitelist your Railway domain or server IP for sandbox access.`;
}

function buildGenerateQrPayload({
  reqTime,
  merchantId,
  tranId,
  amount,
  currency,
  callbackUrl,
  paymentOption,
  firstName,
  lastName,
  email,
  phone,
  returnParams,
  apiKey,
  qrLifetimeMinutes,
  qrTemplate,
}) {
  const payload = {
    req_time: reqTime,
    merchant_id: merchantId,
    tran_id: tranId,
    amount: Number(amount).toFixed(2),
    purchase_type: 'purchase',
    payment_option: paymentOption,
    currency: String(currency ?? 'USD').trim().toUpperCase(),
    callback_url: callbackUrl,
    lifetime: qrLifetimeMinutes,
    qr_image_template: qrTemplate,
  };

  if (firstName) {
    payload.first_name = String(firstName).trim();
  }

  if (lastName) {
    payload.last_name = String(lastName).trim();
  }

  if (email) {
    payload.email = String(email).trim();
  }

  if (phone) {
    payload.phone = String(phone).trim();
  }

  if (returnParams) {
    payload.return_params = String(returnParams).trim();
  }

  console.log('💳 PAYMENT OPTION:', payload.payment_option);
  console.log('💰 AMOUNT SENT:', payload.amount);
  console.log('💱 CURRENCY:', payload.currency);

  payload.hash = createQrHash(payload, apiKey);
  return payload;
}

function buildPurchasePayload({
  reqTime,
  merchantId,
  tranId,
  amount,
  currency,
  callbackUrl,
  paymentOption,
  firstName,
  lastName,
  email,
  phone,
  returnParams,
  apiKey,
}) {
  const payload = {
    req_time: reqTime,
    merchant_id: merchantId,
    tran_id: tranId,
    amount: Number(amount).toFixed(2),
    type: 'purchase',
    payment_option: normalizeLegacyPurchaseOption(paymentOption),
    currency: String(currency ?? 'USD').trim().toUpperCase(),
    return_url: callbackUrl,
  };

  if (firstName) {
    payload.firstname = String(firstName).trim();
  }

  if (lastName) {
    payload.lastname = String(lastName).trim();
  }

  if (email) {
    payload.email = String(email).trim();
  }

  if (phone) {
    payload.phone = String(phone).trim();
  }

  if (returnParams) {
    payload.return_params = String(returnParams).trim();
  }

  payload.hash = createPurchaseHash(payload, apiKey);
  return payload;
}

function normalizeLegacyPurchaseOption(value) {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized || normalized === 'abapay_khqr') {
    return 'abapay';
  }

  return normalized;
}

function toFormData(payload) {
  const form = new FormData();

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    form.append(key, String(value));
  }

  return form;
}