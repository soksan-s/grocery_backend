import nodemailer from 'nodemailer';

import {
  buildPasswordResetCodeEmail,
  buildVerificationCodeEmail,
} from './email_templates.js';

function normalizeText(value) {
  return (value ?? '').toString().trim();
}

function normalizePort(value) {
  const parsed = Number.parseInt(normalizeText(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getEmailConfig() {
  return {
    host: normalizeText(process.env.SMTP_HOST),
    port: normalizePort(process.env.SMTP_PORT),
    user: normalizeText(process.env.SMTP_USER),
    pass: normalizeText(process.env.SMTP_PASS),
    from: normalizeText(process.env.EMAIL_FROM),
  };
}

let cachedTransporter = null;
let cachedTransportKey = '';

function getTransporter(config) {
  const transportKey = `${config.host}:${config.port}:${config.user}`;
  if (cachedTransporter && cachedTransportKey === transportKey) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  cachedTransportKey = transportKey;
  return cachedTransporter;
}

async function sendEmail({ to, subject, html, text }) {
  const config = getEmailConfig();
  const missingConfig = [
    !config.host && 'SMTP_HOST',
    !config.port && 'SMTP_PORT',
    !config.user && 'SMTP_USER',
    !config.pass && 'SMTP_PASS',
    !config.from && 'EMAIL_FROM',
  ].filter(Boolean);

  if (missingConfig.length > 0) {
    return {
      success: false,
      error: `Email delivery is not configured. Missing: ${missingConfig.join(', ')}.`,
    };
  }

  try {
    const transporter = getTransporter(config);
    const info = await transporter.sendMail({
      from: config.from,
      to,
      subject,
      html,
      text,
    });

    return {
      success: true,
      messageId: info.messageId ?? null,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send email.',
    };
  }
}

export async function sendVerificationCodeEmail({ to, firstName, code }) {
  const template = buildVerificationCodeEmail({ firstName, code });
  return sendEmail({
    to,
    subject: 'Verify your Grocery App email',
    html: template.html,
    text: template.text,
  });
}

export async function sendPasswordResetCodeEmail({ to, firstName, code }) {
  const template = buildPasswordResetCodeEmail({ firstName, code });
  return sendEmail({
    to,
    subject: 'Reset your Grocery App password',
    html: template.html,
    text: template.text,
  });
}
