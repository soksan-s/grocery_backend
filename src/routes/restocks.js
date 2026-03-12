import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const rows = await prisma.restock.findMany({
    include: { product: true },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(
    rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      productName: row.product?.name ?? '',
      quantityAdded: row.quantityAdded,
      createdAt: row.createdAt,
    }))
  );
});

export default router;
