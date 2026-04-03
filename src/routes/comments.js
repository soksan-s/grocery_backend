import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function serializeComment(row) {
  return {
    id: row.id,
    productId: row.productId,
    userId: row.userId,
    userEmail: row.user.email,
    userFirstName: row.user.firstName ?? null,
    userLastName: row.user.lastName ?? null,
    userProfileImageUrl: row.user.profileImageUrl ?? null,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get('/', async (req, res) => {
  const productId = req.query.productId?.toString();
  if (!productId) {
    return res.status(400).json({ error: 'productId is required.' });
  }

  const rows = await prisma.productComment.findMany({
    where: { productId },
    include: { user: true },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    data: rows.map(serializeComment),
  });
});

router.post('/', requireAuth, async (req, res) => {
  const { productId, message } = req.body || {};
  if (!productId || !message || message.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Invalid comment.' });
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  const row = await prisma.productComment.create({
    data: {
      productId,
      userId: req.user.id,
      message: message.toString().trim(),
    },
    include: { user: true },
  });

  return res.status(201).json(serializeComment(row));
});

router.patch('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { message } = req.body || {};
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid comment id.' });
  }
  if (!message || message.toString().trim().length < 3) {
    return res.status(400).json({ error: 'Invalid comment.' });
  }

  const existing = await prisma.productComment.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!existing) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  if (req.user.role !== 'admin' && existing.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const row = await prisma.productComment.update({
    where: { id },
    data: { message: message.toString().trim() },
    include: { user: true },
  });

  return res.json(serializeComment(row));
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid comment id.' });
  }

  const existing = await prisma.productComment.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  if (req.user.role !== 'admin' && existing.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.productComment.delete({ where: { id } });
  return res.status(204).send();
});

export default router;
