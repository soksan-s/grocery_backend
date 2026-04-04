import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  sendPasswordResetCodeEmail,
  sendVerificationCodeEmail,
} from '../services/email.js';
import { ensureLegacyPasswordUserVerified } from '../services/user_verification.js';


const router = Router();
const googleOauthClient = new OAuth2Client();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function normalizeText(value) {
  return (value ?? '').toString().trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeCredentials(rawEmail, rawPassword) {
  const email = (rawEmail ?? '').toString().trim().toLowerCase();
  const password = (rawPassword ?? '').toString();
  return { email, password };
}

function normalizeName(rawValue) {
  return (rawValue ?? '').toString().trim();
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function createOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function buildEmailFailureHint(errorMessage) {
  const normalized = normalizeText(errorMessage).toLowerCase();

  if (normalized.includes('email delivery is not configured')) {
    return 'Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and EMAIL_FROM in Railway.';
  }

  if (
    normalized.includes('invalid login') ||
    normalized.includes('authentication') ||
    normalized.includes('auth') ||
    normalized.includes('535')
  ) {
    return 'Check Railway SMTP credentials. If you use Gmail, use a Google App Password and make sure it is copied correctly.';
  }

  return 'Check Railway SMTP settings and server logs, then try again.';
}

function signAuthToken(user) {
  const payload = { id: user.id, email: user.email, role: user.role };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function buildAuthResponse(user, { message } = {}) {
  const response = {
    token: signAuthToken(user),
    user: serializeUser(user),
  };

  if (message) {
    response.message = message;
  }

  return response;
}

function mergeGoogleProfile(user, profile) {
  const data = {
    emailVerified: true,
    lastLoginAt: new Date(),
  };

  if (!user.firstName && profile.firstName) {
    data.firstName = profile.firstName;
  }
  if (!user.lastName && profile.lastName) {
    data.lastName = profile.lastName;
  }
  if (!user.profileImageUrl && profile.picture) {
    data.profileImageUrl = profile.picture;
  }

  return data;
}

async function verifyGoogleIdToken(idToken, audience) {
  const ticket = await googleOauthClient.verifyIdToken({
    idToken,
    audience,
  });
  const payload = ticket.getPayload();

  const googleSub = normalizeText(payload?.sub);
  const email = normalizeEmail(payload?.email);
  const firstName = normalizeName(payload?.given_name);
  const lastName = normalizeName(payload?.family_name);
  const picture = normalizeText(payload?.picture);
  const isEmailVerified = payload?.email_verified === true;

  if (!googleSub || !email || !isEmailVerified) {
    throw new Error('Google account email is missing or not verified.');
  }

  return {
    googleSub,
    email,
    firstName,
    lastName,
    picture,
  };
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    profileImageUrl: user.profileImageUrl ?? null,
    role: user.role,
  };
}

async function deleteOtpRecord(recordId, failureLabel) {
  try {
    await prisma.otpVerification.deleteMany({
      where: { id: recordId },
    });
  } catch (err) {
    console.error(failureLabel, err);
  }
}

async function rollbackRegistration(userId, otpRecordId) {
  try {
    await prisma.$transaction([
      prisma.otpVerification.deleteMany({
        where: { id: otpRecordId },
      }),
      prisma.user.delete({
        where: { id: userId },
      }),
    ]);
  } catch (err) {
    console.error('Register email cleanup failed:', err);
  }
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = normalizeCredentials(
      req.body?.email,
      req.body?.password,
    );
    const firstName = normalizeName(req.body?.firstName);
    const lastName = normalizeName(req.body?.lastName);

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        error: 'First name, last name, email, and password are required.',
      });
    }

    if (firstName.length < 2 || lastName.length < 2) {
      return res.status(400).json({
        error: 'First name and last name must be at least 2 characters long.',
      });
    }

    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Email is invalid.' });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters long.',
      });
    }

    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({
        error: 'Password must include at least one letter and one number.',
      });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already exists.' });
    }

    const hash = bcrypt.hashSync(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash: hash,
        emailVerified: false,
        role: 'client',
      },
    });

    const verifyCode = createOtpCode();
    const verifyCodeHash = bcrypt.hashSync(verifyCode, 10);

    const verificationRecord = await prisma.otpVerification.create({
      data: {
        userId: user.id,
        target: email,
        type: 'email_verify',
        codeHash: verifyCodeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const verificationEmail = await sendVerificationCodeEmail({
      to: email,
      firstName,
      code: verifyCode,
    });

    if (!verificationEmail.success) {
      console.error(
        'Register verification email failed:',
        verificationEmail.error,
      );
      await rollbackRegistration(user.id, verificationRecord.id);
      return res.status(500).json({
        error:
          'Unable to send verification email right now. Please try registering again.',
      });
    }

    if (!isProduction()) {
      console.log('Register verification email sent:', email);
    }

    return res.status(201).json(buildAuthResponse(user, {
      message:
        'Registration successful. Please check your email for the verification code.',
    }));
  } catch (err) {
    console.error('Register failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = normalizeCredentials(
      req.body?.email,
      req.body?.password,
    );

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    let user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        googleSub: true,
        emailVerified: true,
        role: true,
        createdAt: true,
      },
    });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!user.passwordHash) {
      return res.status(400).json({
        error: user.googleSub
          ? 'This account uses Google sign-in. Continue with Google instead.'
          : 'This account does not have a password login configured.',
      });
    }

    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    user = await ensureLegacyPasswordUserVerified(user);

    if (user.role !== 'admin' && !user.emailVerified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in.',
      });
    }

    const authenticatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return res.json(buildAuthResponse(authenticatedUser));
  } catch (err) {
    console.error('Login failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/google', authLimiter, async (req, res) => {
  try {
    const idToken = normalizeText(req.body?.idToken);
    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required.' });
    }

    // Required in server/.env (and in your production host environment):
    // GOOGLE_CLIENT_ID=YOUR_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com
    const googleClientId = normalizeText(process.env.GOOGLE_CLIENT_ID);
    if (!googleClientId) {
      return res.status(500).json({
        error:
          'Google sign-in is not configured on the server. Add GOOGLE_CLIENT_ID to server/.env.',
      });
    }

    let googleProfile;
    try {
      googleProfile = await verifyGoogleIdToken(idToken, googleClientId);
    } catch (err) {
      console.error('Google token verification failed:', err);
      return res.status(401).json({ error: 'Invalid Google ID token.' });
    }

    const now = new Date();

    let user = await prisma.user.findUnique({
      where: { googleSub: googleProfile.googleSub },
    });

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: mergeGoogleProfile(user, googleProfile),
      });
      return res.json(buildAuthResponse(user));
    }

    const existingByEmail = await prisma.user.findUnique({
      where: { email: googleProfile.email },
    });

    if (existingByEmail) {
      if (
        existingByEmail.googleSub &&
        existingByEmail.googleSub !== googleProfile.googleSub
      ) {
        return res.status(409).json({
          error: 'This email is already linked to another Google account.',
        });
      }

      user = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          ...mergeGoogleProfile(existingByEmail, googleProfile),
          googleSub: googleProfile.googleSub,
        },
      });
      return res.json(buildAuthResponse(user));
    }

    user = await prisma.user.create({
      data: {
        email: googleProfile.email,
        firstName: googleProfile.firstName || null,
        lastName: googleProfile.lastName || null,
        profileImageUrl: googleProfile.picture || null,
        googleSub: googleProfile.googleSub,
        emailVerified: true,
        lastLoginAt: now,
        role: 'client',
      },
    });

    return res.status(201).json(buildAuthResponse(user));
  } catch (err) {
    console.error('Google login failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/users/search', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rawQuery = normalizeName(req.query?.query ?? req.query?.q);
    const terms = rawQuery
      .toLowerCase()
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (terms.length === 0) {
      return res.json({ data: [] });
    }

    const users = await prisma.user.findMany({
      where: {
        role: 'client',
        AND: terms.map((term) => ({
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
          ],
        })),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
        role: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { email: 'asc' }],
      take: 12,
    });

    return res.json({ data: users.map(serializeUser) });
  } catch (err) {
    console.error('User search failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        profileImageUrl: true,
        role: true,
      },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.json({ user: serializeUser(user) });
  } catch (err) {
    console.error('Session check failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const email = (req.body?.email ?? '').trim().toLowerCase();

    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Valid email required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.json({ message: 'If that email exists, a reset code was sent.' });
    }

    const code = createOtpCode();

    const hash = bcrypt.hashSync(code, 10);

    const resetRecord = await prisma.otpVerification.create({
      data: {
        userId: user.id,
        target: email,
        type: 'reset_password',
        codeHash: hash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const resetEmail = await sendPasswordResetCodeEmail({
      to: email,
      firstName: user.firstName,
      code,
    });

    if (!resetEmail.success) {
      console.error('Password reset email failed:', resetEmail.error);
      await deleteOtpRecord(
        resetRecord.id,
        'Password reset OTP cleanup failed:',
      );
      return res.status(500).json({
        error: 'Unable to send password reset email right now. Please try again.',
        hint: buildEmailFailureHint(resetEmail.error),
      });
    }

    if (!isProduction()) {
      console.log('Password reset email sent:', email);
    }

    return res.json({
      message: 'If that email exists, a reset code was sent.',
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const email = (req.body?.email ?? '').trim().toLowerCase();
    const code = (req.body?.code ?? '').trim();
    const newPassword = req.body?.newPassword ?? '';

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const record = await prisma.otpVerification.findFirst({
      where: {
        userId: user.id,
        type: 'reset_password',
        verifiedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!record) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    const valid = bcrypt.compareSync(code, record.codeHash);

    if (!valid) {
      return res.status(400).json({ error: "Invalid code" });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash }
    });

    await prisma.otpVerification.update({
      where: { id: record.id },
      data: { verifiedAt: new Date() }
    });

    res.json({ message: "Password reset successful" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post('/send-email-verification', authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Valid email required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.emailVerified) {
      return res.json({ message: 'Email already verified.' });
    }

    const code = createOtpCode();
    const codeHash = bcrypt.hashSync(code, 10);

    const verificationRecord = await prisma.otpVerification.create({
      data: {
        userId: user.id,
        target: email,
        type: 'email_verify',
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const verificationEmail = await sendVerificationCodeEmail({
      to: email,
      firstName: user.firstName,
      code,
    });

    if (!verificationEmail.success) {
      console.error(
        'Email verification send failed:',
        verificationEmail.error,
      );
      await deleteOtpRecord(
        verificationRecord.id,
        'Verification OTP cleanup failed:',
      );
      return res.status(500).json({
        error: 'Unable to send verification email right now. Please try again.',
        hint: buildEmailFailureHint(verificationEmail.error),
      });
    }

    if (!isProduction()) {
      console.log('Verification email sent:', email);
    }

    return res.json({
      message: 'Verification code sent. Check your email.',
    });
  } catch (err) {
    console.error('send-email-verification failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/verify-email', authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = normalizeText(req.body?.code);

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const record = await prisma.otpVerification.findFirst({
      where: {
        userId: user.id,
        target: email,
        type: 'email_verify',
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }

    const valid = bcrypt.compareSync(code, record.codeHash);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid code.' });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      }),
      prisma.otpVerification.update({
        where: { id: record.id },
        data: { verifiedAt: new Date() },
      }),
    ]);

    return res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    console.error('verify-email failed:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// TODO: Add /refresh and /logout routes when refresh-token issuance, rotation,
// and revocation are wired into both the RefreshToken table and the Flutter app.

export default router;
