function normalizeText(value) {
  return (value ?? '').toString().trim();
}

function escapeHtml(value) {
  return normalizeText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Customize your product name here.
const APP_NAME = 'Grocery App';
// Customize your brand colors here.
const BRAND_COLOR = '#0F766E';
const BRAND_TEXT_COLOR = '#FFFFFF';
const PAGE_BACKGROUND = '#F4F7FB';
const CARD_BACKGROUND = '#FFFFFF';
const BORDER_COLOR = '#D9E2EC';
const TITLE_COLOR = '#0F172A';
const BODY_COLOR = '#334155';
const MUTED_COLOR = '#64748B';
const CODE_BACKGROUND = '#E6FFFA';
const CODE_TEXT_COLOR = '#0F172A';

function buildCodeEmailTemplate({
  title,
  intro,
  codeLabel,
  code,
  firstName,
  footerNote,
  preheader,
}) {
  const safeAppName = escapeHtml(APP_NAME);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeCodeLabel = escapeHtml(codeLabel);
  const safeCode = escapeHtml(code);
  const safeFooterNote = escapeHtml(footerNote);
  const safePreheader = escapeHtml(preheader);
  const safeName = escapeHtml(firstName) || 'there';
  const plainName = normalizeText(firstName) || 'there';
  const plainCode = normalizeText(code);

  return {
    html: `
<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:${PAGE_BACKGROUND};font-family:Arial,sans-serif;color:${BODY_COLOR};">
    <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">
      ${safePreheader}
    </span>
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;margin-bottom:20px;">
        <span style="display:inline-block;padding:10px 18px;border-radius:999px;background:${BRAND_COLOR};color:${BRAND_TEXT_COLOR};font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
          ${safeAppName}
        </span>
      </div>
      <div style="background:${CARD_BACKGROUND};border:1px solid ${BORDER_COLOR};border-radius:24px;padding:32px;box-shadow:0 18px 48px rgba(15,23,42,0.08);">
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;color:${TITLE_COLOR};text-align:center;">
          ${safeTitle}
        </h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${BODY_COLOR};text-align:center;">
          Hi ${safeName},
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:${BODY_COLOR};text-align:center;">
          ${safeIntro}
        </p>
        <div style="margin:0 auto 24px;max-width:360px;padding:24px 20px;border-radius:18px;background:${CODE_BACKGROUND};text-align:center;">
          <div style="margin-bottom:12px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED_COLOR};">
            ${safeCodeLabel}
          </div>
          <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:${CODE_TEXT_COLOR};">
            ${safeCode}
          </div>
        </div>
        <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${MUTED_COLOR};text-align:center;">
          This code expires in 10 minutes.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:${MUTED_COLOR};text-align:center;">
          ${safeFooterNote}
        </p>
      </div>
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${MUTED_COLOR};text-align:center;">
        This is an automated message from ${safeAppName}.
      </p>
    </div>
  </body>
</html>`.trim(),
    text: [
      APP_NAME,
      '',
      title,
      '',
      `Hi ${plainName},`,
      intro,
      '',
      `${codeLabel}: ${plainCode}`,
      'This code expires in 10 minutes.',
      '',
      footerNote,
    ].join('\n'),
  };
}

export function buildVerificationCodeEmail({ firstName, code }) {
  return buildCodeEmailTemplate({
    title: 'Verify your email',
    intro:
      'Use the verification code below to confirm your email address and finish setting up your account.',
    codeLabel: 'Verification code',
    code,
    firstName,
    footerNote:
      'If you did not create an account, you can safely ignore this email.',
    preheader: 'Your email verification code is ready.',
  });
}

export function buildPasswordResetCodeEmail({ firstName, code }) {
  return buildCodeEmailTemplate({
    title: 'Reset your password',
    intro:
      'Use the password reset code below to choose a new password for your account.',
    codeLabel: 'Reset code',
    code,
    firstName,
    footerNote:
      'If you did not request a password reset, you can safely ignore this email.',
    preheader: 'Your password reset code is ready.',
  });
}
