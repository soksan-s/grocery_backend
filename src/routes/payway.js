import crypto from 'crypto';
import express from 'express';
import https from 'https';

const router = express.Router();

const PAYWAY_CONFIG = {
  merchantId: (process.env.PAYWAY_MERCHANT_ID ?? '').trim(),
  publicKey: (process.env.PAYWAY_PUBLIC_KEY ?? '').trim(),
  isSandbox: process.env.PAYWAY_SANDBOX !== 'false',
  qrApiUrl:
    process.env.PAYWAY_QR_API_URL ||
    'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr',
  checkTransactionUrl:
    process.env.PAYWAY_CHECK_API_URL ||
    'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/check-transaction-2',
  callbackUrl:
    (process.env.PAYWAY_CALLBACK_URL ?? process.env.SERVER_PUBLIC_URL ?? '')
      .trim()
      .replace(/\/$/, ''),
};

const QR_HASH_ORDER = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'first_name',
  'last_name',
  'email',
  'phone',
  'payment_option',
  'currency',
  'return_params',
  'lifetime',
];

// const QR_HASH_ORDER = [
//   'req_time',
//   'merchant_id',
//   'tran_id',
//   'amount',
//   'items',
//   'first_name',
//   'last_name',
//   'email',
//   'phone',
//   'purchase_type',
//   'payment_option',
//   'callback_url',
//   'return_deeplink',
//   'currency',
//   'custom_fields',
//   'return_params',
//   'payout',
//   'lifetime',
//   'qr_image_template',
// ];

function getConfigError() {
  if (!PAYWAY_CONFIG.merchantId || !PAYWAY_CONFIG.publicKey) {
    return 'PayWay is not configured. Set PAYWAY_MERCHANT_ID and PAYWAY_PUBLIC_KEY in server/.env.';
  }
  return null;
}

function getReqTime() {
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

function normalizeUrl(url) {
  return String(url ?? '').trim().replace(/\/$/, '');
}

function createCallbackUrl(overrideUrl) {
  const candidate = normalizeUrl(overrideUrl) || PAYWAY_CONFIG.callbackUrl;
  if (!candidate) {
    return '';
  }
  if (candidate.endsWith('/api/payment/callback')) {
    return candidate;
  }
  return `${candidate}/api/payment/callback`;
}

  function serializeForHash(value) {
    if (value === undefined || value === null) {
      return '';
    }

    // 🔥 IMPORTANT: keep empty string as empty slot
    if (value === '') {
      return '';
    }

    if (Array.isArray(value) || typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

// function serializeForHash(value) {
//   if (value === undefined || value === null || value === '') {
//     return '';
//   }
//   if (Array.isArray(value) || typeof value === 'object') {
//     return JSON.stringify(value);
//   }
//   return String(value);
// }

function buildHashString(payload, orderedKeys) {
  return orderedKeys.map((key) => serializeForHash(payload[key])).join('');
}

function generateHash(hashString, publicKey) {
  return crypto
    .createHmac('sha512', publicKey)
    .update(hashString)
    .digest('base64');
}

function createTranId(orderId) {
  const timePart = Date.now().toString().slice(-8);
  const hashPart = crypto
    .createHash('sha1')
    .update(String(orderId))
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();

  return `PW${timePart}${hashPart}`;
}

function mapQrPaymentOption(paymentOption) {
  const normalized = String(paymentOption ?? 'abapay').trim().toLowerCase();

  switch (normalized) {
    case 'abapay':
    case 'abapay_deeplink':
      return 'abapay_khqr';
    case 'bakong':
      return 'khqr';
    default:
      return normalized;
  }
}

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const bodyBuffer = Buffer.from(body, 'utf8');

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length,
      },
    };

    const request = https.request(options, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          resolve({
            httpStatus: response.statusCode ?? 500,
            body: JSON.parse(data),
          });
        } catch {
          reject(
            new Error(
              `PayWay returned a non-JSON response (${response.statusCode ?? 500}): ${data.slice(0, 300)}`,
            ),
          );
        }
      });
    });

    request.on('error', reject);
    request.write(bodyBuffer);
    request.end();
  });
}

function formatPayWayError(status, fallbackMessage) {
  const code = status?.code?.toString() ?? null;
  let message = status?.message || fallbackMessage;

  if (code === '6') {
    message = `${message} Ask ABA to whitelist your server domain or outbound IP for sandbox access.`;
  }

  return { code, message };
}

function isApprovedStatus(paymentStatus) {
  const normalized = String(paymentStatus ?? '').trim().toUpperCase();
  return normalized === 'APPROVED' || normalized === 'SUCCESS' || normalized === 'PAID';
}

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');

  if (leftBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildCallbackSignature(payload) {
  const sortedKeys = Object.keys(payload).sort();
  const signatureBody = buildHashString(payload, sortedKeys);
  return generateHash(signatureBody, PAYWAY_CONFIG.publicKey);
}

router.post('/create-payment', async (req, res) => {
  try {
    const configError = getConfigError();
    if (configError) {
      return res.status(500).json({ success: false, message: configError });
    }

    const requestBody = req.body ?? {};
    const {
      orderId,
      amount,
      paymentOption = 'abapay',
      currency = 'USD',
      firstname,
      lastname,
      email,
      phone,
      callbackUrl,
    } = requestBody;

    if (!orderId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'orderId and amount are required',
      });
    }

    const parsedAmount = Number.parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'amount must be a positive number',
      });
    }

    const reqTime = getReqTime();
    const tranId = createTranId(orderId);
    const amountString = Number(parsedAmount).toFixed(2);
    console.log("🚀 SENDING AMOUNT TO ABA:", amountString);
    console.log("🚀 TYPE:", typeof amountString);
    const resolvedCallbackUrl = createCallbackUrl(callbackUrl);

    const payload = {
      req_time: reqTime,
      merchant_id: PAYWAY_CONFIG.merchantId,
      tran_id: tranId,
      amount: amountString,

      first_name: firstname || "",
      last_name: lastname || "",
      email: email || "",
      phone: phone || "",

      payment_option: mapQrPaymentOption(paymentOption),
      currency: "USD",

      return_params: String(orderId),
      lifetime: 3,
    };

    // const payload = {
    //   req_time: reqTime,
    //   merchant_id: PAYWAY_CONFIG.merchantId,
    //   tran_id: tranId,
    //   amount: amountString,

    //   // 🔥 REQUIRED EMPTY FIELDS
    //   items: "",
    //   first_name: firstname || "",
    //   last_name: lastname || "",
    //   email: email || "",
    //   phone: phone || "",

    //   purchase_type: 'purchase',
    //   payment_option: mapQrPaymentOption(paymentOption),

    //   callback_url: resolvedCallbackUrl
    //     ? Buffer.from(resolvedCallbackUrl).toString('base64')
    //     : "",

    //   return_deeplink: "",   // 🔥 ADD THIS
    //   currency: String(currency || "USD").toUpperCase(),
    //   custom_fields: "",     // 🔥 ADD THIS
    //   return_params: String(orderId),
    //   payout: "",            // 🔥 ADD THIS
    //   lifetime: 3,
    //   qr_image_template: 'template3_color',
    // };

    console.log("📦 FINAL PAYLOAD:", payload);
  console.log("🔐 HASH STRING:", buildHashString(payload, QR_HASH_ORDER));

    // const payload = {
    //   req_time: reqTime,
    //   merchant_id: PAYWAY_CONFIG.merchantId,
    //   tran_id: tranId,
    //   amount: amountString,
    //   purchase_type: 'purchase',
    //   payment_option: mapQrPaymentOption(paymentOption),
    //   currency,
    //   return_params: String(orderId),
    //   lifetime: 3,
    //   qr_image_template: 'template3_color',
    // };

    if (firstname) {
      payload.first_name = firstname;
    }
    if (lastname) {
      payload.last_name = lastname;
    }
    if (email) {
      payload.email = email;
    }
    if (phone) {
      payload.phone = phone;
    }
    // if (resolvedCallbackUrl) {
    //   payload.callback_url = Buffer.from(resolvedCallbackUrl, 'utf8').toString('base64');
    // }

    console.log("📦 PAYLOAD BEFORE HASH:", payload);
    const hashString = buildHashString(payload, QR_HASH_ORDER);

    console.log("====== ABA DEBUG ======");
    console.log("Payload:", payload);
    console.log("HASH STRING:", hashString);

    const hash = generateHash(hashString, PAYWAY_CONFIG.publicKey);

    console.log("HASH (base64):", hash);
    console.log("=======================");

    // const hash = generateHash(
    //   buildHashString(payload, QR_HASH_ORDER),
    //   PAYWAY_CONFIG.publicKey,
    // );

    const { body: paywayResponse, httpStatus } = await postJson(
      PAYWAY_CONFIG.qrApiUrl,
      {
        ...payload,
        hash,
      },
    );

    if (
      (paywayResponse.status?.code === '0' ||
        paywayResponse.status?.code === '00') &&
      (paywayResponse.qrString ||
        paywayResponse.qrImage ||
        paywayResponse.abapay_deeplink)
    ) {
      return res.json({
        success: true,
        tranId,
        qrString: paywayResponse.qrString ?? null,
        qrImage: paywayResponse.qrImage ?? null,
        abaDeeplink: paywayResponse.abapay_deeplink ?? null,
        appStore: paywayResponse.app_store ?? null,
        playStore: paywayResponse.play_store ?? null,
        currency: paywayResponse.currency ?? currency,
        amount: paywayResponse.amount ?? amountString,
        paymentOption: payload.payment_option,
      });
    }

    const error = formatPayWayError(
      paywayResponse.status,
      'PayWay rejected the QR request.',
    );

    return res.status(httpStatus >= 400 ? httpStatus : 422).json({
      success: false,
      code: error.code,
      message: error.message,
      details: paywayResponse,
    });
  } catch (error) {
    console.error('[PayWay] create-payment error:', error);
    return res.status(502).json({
      success: false,
      message: `Unable to reach PayWay sandbox: ${error.message}`,
    });
  }
});

router.post('/check-transaction', async (req, res) => {
  try {
    const configError = getConfigError();
    if (configError) {
      return res.status(500).json({ success: false, message: configError });
    }

    const { tranId } = req.body ?? {};
    if (!tranId) {
      return res.status(400).json({
        success: false,
        message: 'tranId is required',
      });
    }

    const reqTime = getReqTime();
    const hash = generateHash(
      `${reqTime}${PAYWAY_CONFIG.merchantId}${tranId}`,
      PAYWAY_CONFIG.publicKey,
    );

    const { body: paywayResponse, httpStatus } = await postJson(
      PAYWAY_CONFIG.checkTransactionUrl,
      {
        req_time: reqTime,
        merchant_id: PAYWAY_CONFIG.merchantId,
        tran_id: tranId,
        hash,
      },
    );

    const apiCode = paywayResponse.status?.code?.toString() ?? null;
    const paymentStatus = paywayResponse.data?.payment_status ?? null;
    const paymentStatusCode = paywayResponse.data?.payment_status_code ?? null;

    return res.status(httpStatus >= 400 ? httpStatus : 200).json({
      success: apiCode === '00',
      paid: isApprovedStatus(paymentStatus),
      paymentStatus,
      paymentStatusCode,
      tranId: paywayResponse.status?.tran_id ?? tranId,
      data: paywayResponse,
    });
  } catch (error) {
    console.error('[PayWay] check-transaction error:', error);
    return res.status(502).json({
      success: false,
      paid: false,
      message: `Unable to reach PayWay sandbox: ${error.message}`,
    });
  }
});

router.post('/api/payment/callback', async (req, res) => {
  try {
    const payload = req.body ?? {};
    const signature = req.get('x-payway-hmac-sha512') ?? '';

    if (signature && PAYWAY_CONFIG.publicKey) {
      const expectedSignature = buildCallbackSignature(payload);
      if (!timingSafeMatch(signature, expectedSignature)) {
        return res.status(401).json({ error: 'Invalid PayWay signature.' });
      }
    }

    const status = String(payload.status ?? '').trim();
    const paid = status === '0' || status === '00' || isApprovedStatus(status);

    console.log('[PayWay] pushback received', {
      tranId: payload.tran_id ?? null,
      status,
      paid,
      returnParams: payload.return_params ?? null,
      apv: payload.apv ?? null,
    });

    return res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('[PayWay] pushback error:', error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
