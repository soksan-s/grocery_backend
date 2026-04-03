import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/:productId', requireAuth, async (req, res) => {
  const productId = req.params.productId;
  const rating = Number(req.body?.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1-5.' });
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  const existing = await prisma.productRating.findUnique({
    where: { userId_productId: { userId: req.user.id, productId } },
  });

  let nextAvg = product.ratingAvg ?? 0;
  let nextCount = product.ratingCount ?? 0;

  if (existing) {
    const total = nextAvg * nextCount - existing.rating + rating;
    nextAvg = nextCount > 0 ? total / nextCount : rating;
    await prisma.productRating.update({
      where: { id: existing.id },
      data: { rating },
    });
  } else {
    const total = nextAvg * nextCount + rating;
    nextCount += 1;
    nextAvg = total / nextCount;
    await prisma.productRating.create({
      data: {
        userId: req.user.id,
        productId,
        rating,
      },
    });
  }

  const updated = await prisma.product.update({
    where: { id: productId },
    data: {
      ratingAvg: nextAvg,
      ratingCount: nextCount,
    },
  });

  return res.json({
    ratingAvg: updated.ratingAvg,
    ratingCount: updated.ratingCount,
  });
});

export default router;
