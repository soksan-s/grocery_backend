import { Router } from 'express';

import prisma from '../db.js';
import { getFallbackCategories, isDatabaseUnavailable } from '../dev_catalog.js';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.product.findMany({
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    const categories = rows.map((row) => row.category);
    return res.json({ data: categories });
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return res.json({ data: getFallbackCategories() });
    }
    return next(error);
  }
});

export default router;
