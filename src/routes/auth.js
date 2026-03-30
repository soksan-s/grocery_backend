import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function normalizeCredentials(rawEmail, rawPassword) {
  const email = (rawEmail ?? '').toString().trim().toLowerCase();
  const password = (rawPassword ?? '').toString();
  return { email, password };
}

function normalizeName(rawValue) {
  return (rawValue ?? '').toString().trim();
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
        role: 'client',
      },
    });

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    return res.status(201).json({ token, user: serializeUser(user) });
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

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

    return res.json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error('Login failed:', err);
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

export default router;
