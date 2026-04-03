import jwt from 'jsonwebtoken';

import prisma from '../db.js';
import { ensureLegacyPasswordUserVerified } from '../services/user_verification.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    let user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        email: true,
        role: true,
        emailVerified: true,
        passwordHash: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found.' });
    }

    user = await ensureLegacyPasswordUserVerified(user);

    if (user.role !== 'admin' && !user.emailVerified) {
      return res.status(403).json({
        error: 'Please verify your email before using your account.',
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };
}
