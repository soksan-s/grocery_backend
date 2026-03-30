import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, requireRole('admin'), async (_req, res) => {
  const rows = await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  return res.json({ data: await serializeCoupons(rows) });
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { code, type, value, audience, description, startsAt, endsAt, userEmail } =
    req.body || {};
  const normalizedCode = (code ?? '').toString().trim().toUpperCase();
  if (!normalizedCode || (type !== 'percent' && type !== 'amount')) {
    return res.status(400).json({ error: 'Invalid coupon payload.' });
  }
  const audienceValue = audience === 'user' ? 'user' : 'all';
  const normalizedUserEmail = normalizeEmail(userEmail);
  if (audienceValue === 'user' && !normalizedUserEmail) {
    return res.status(400).json({ error: 'User email is required.' });
  }
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return res.status(400).json({ error: 'Invalid coupon value.' });
  }
  if (type === 'percent' && parsedValue > 90) {
    return res.status(400).json({ error: 'Percent too high (max 90).' });
  }
  const parsedStartsAt = parseOptionalDate(startsAt);
  const parsedEndsAt = parseOptionalDate(endsAt);
  if ((startsAt && !parsedStartsAt) || (endsAt && !parsedEndsAt)) {
    return res.status(400).json({ error: 'Invalid coupon date.' });
  }
  if (parsedStartsAt && parsedEndsAt && parsedEndsAt < parsedStartsAt) {
    return res.status(400).json({ error: 'End date must be after start date.' });
  }

  const existing = await prisma.coupon.findUnique({
    where: { code: normalizedCode },
  });
  if (existing) {
    return res.status(409).json({ error: 'Coupon code already exists.' });
  }

  let targetUser = null;
  if (audienceValue === 'user') {
    targetUser = await prisma.user.findUnique({
      where: { email: normalizedUserEmail },
      select: userSummarySelect,
    });
    if (!targetUser || targetUser.role !== 'client') {
      return res.status(404).json({ error: 'Selected user was not found.' });
    }
  }

  const row = await prisma.coupon.create({
    data: {
      code: normalizedCode,
      type,
      value: parsedValue,
      isActive: true,
      audience: audienceValue,
      description: description?.toString(),
      startsAt: parsedStartsAt,
      endsAt: parsedEndsAt,
      userEmail: targetUser?.email ?? null,
    },
  });
  return res.status(201).json(serializeCoupon(row, targetUser));
});

router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { isActive, value, type, audience, description, startsAt, endsAt, userEmail } =
    req.body || {};
  const existing = await prisma.coupon.findUnique({
    where: { id: Number(req.params.id) },
  });
  if (!existing) {
    return res.status(404).json({ error: 'Coupon not found.' });
  }

  let nextValue = existing.value;
  if (value != null) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return res.status(400).json({ error: 'Invalid coupon value.' });
    }
    nextValue = parsed;
  }

  let nextType = existing.type;
  if (type === 'percent' || type === 'amount') {
    nextType = type;
  }

  if (nextType === 'percent' && nextValue > 90) {
    return res.status(400).json({ error: 'Percent too high (max 90).' });
  }
  const nextAudience = audience === 'user' ? 'user' : 'all';
  const nextUserEmail = normalizeEmail(userEmail) ?? normalizeEmail(existing.userEmail);
  if (nextAudience === 'user' && !nextUserEmail) {
    return res.status(400).json({ error: 'User email is required.' });
  }
  const nextStartsAt =
    startsAt === undefined
      ? existing.startsAt
      : startsAt
      ? parseOptionalDate(startsAt)
      : null;
  const nextEndsAt =
    endsAt === undefined
      ? existing.endsAt
      : endsAt
      ? parseOptionalDate(endsAt)
      : null;
  if ((startsAt && !nextStartsAt) || (endsAt && !nextEndsAt)) {
    return res.status(400).json({ error: 'Invalid coupon date.' });
  }
  if (nextStartsAt && nextEndsAt && nextEndsAt < nextStartsAt) {
    return res.status(400).json({ error: 'End date must be after start date.' });
  }

  let nextTargetUser = null;
  if (nextAudience === 'user') {
    nextTargetUser = await prisma.user.findUnique({
      where: { email: nextUserEmail },
      select: userSummarySelect,
    });
    if (!nextTargetUser || nextTargetUser.role !== 'client') {
      return res.status(404).json({ error: 'Selected user was not found.' });
    }
  }

  const row = await prisma.coupon.update({
    where: { id: existing.id },
    data: {
      isActive: isActive == null ? existing.isActive : Boolean(isActive),
      type: nextType,
      value: nextValue,
      audience: nextAudience,
      description: description == null ? existing.description : description,
      startsAt: nextStartsAt,
      endsAt: nextEndsAt,
      userEmail: nextAudience === 'user' ? nextTargetUser?.email ?? null : null,
    },
  });
  return res.json(serializeCoupon(row, nextTargetUser));
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Coupon not found.' });
  }
  const redemptionCount = await prisma.couponRedemption.count({
    where: { couponId: id },
  });
  if (redemptionCount > 0) {
    const row = await prisma.coupon.update({
      where: { id },
      data: { isActive: false },
    });
    return res.json({
      archived: true,
      coupon: row,
      message: 'Coupon has already been used and was deactivated instead of deleted.',
    });
  }
  await prisma.coupon.delete({ where: { id } });
  return res.status(204).send();
});

router.get('/active', requireAuth, async (req, res) => {
  const now = new Date();
  const rows = await prisma.coupon.findMany({
    where: {
      isActive: true,
      couponRedemptions: {
        none: { userId: req.user.id },
      },
      OR: [
        { startsAt: null },
        { startsAt: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { endsAt: null },
            { endsAt: { gte: now } },
          ],
        },
        {
          OR: [
            { audience: 'all' },
            { audience: 'user', userEmail: req.user.email },
          ],
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ data: await serializeCoupons(rows) });
});

export default router;

const userSummarySelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  profileImageUrl: true,
  role: true,
};

function parseOptionalDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function normalizeEmail(value) {
  const normalized = (value ?? '').toString().trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

async function serializeCoupons(rows) {
  const emails = [
    ...new Set(
      rows
        .map((row) => normalizeEmail(row.userEmail))
        .filter(Boolean),
    ),
  ];

  const users = emails.length
    ? await prisma.user.findMany({
        where: { email: { in: emails } },
        select: userSummarySelect,
      })
    : [];

  const usersByEmail = new Map(
    users.map((user) => [user.email.toLowerCase(), user]),
  );

  return rows.map((row) =>
    serializeCoupon(
      row,
      normalizeEmail(row.userEmail)
        ? usersByEmail.get(normalizeEmail(row.userEmail)) ?? null
        : null,
    ),
  );
}

function serializeCoupon(row, targetUser) {
  return {
    ...row,
    targetUser: targetUser
      ? {
          id: targetUser.id,
          email: targetUser.email,
          firstName: targetUser.firstName ?? null,
          lastName: targetUser.lastName ?? null,
          profileImageUrl: targetUser.profileImageUrl ?? null,
          role: targetUser.role ?? null,
        }
      : null,
  };
}
