import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import prisma from '../db.js';
import {
  getFallbackProductById,
  getFallbackProducts,
  isDatabaseUnavailable,
} from '../dev_catalog.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { active } = req.query;
    const includeInactive = active === 'false';

    const rows = await prisma.product.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(rows.map(mapProduct));
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      const includeInactive = req.query.active === 'false';
      return res.json(
        getFallbackProducts({ includeInactive }).map(mapProduct),
      );
    }
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!row) {
      return res.status(404).json({ error: 'Product not found.' });
    }
    return res.json(mapProduct(row));
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      const row = getFallbackProductById(req.params.id);
      if (!row) {
        return res.status(404).json({ error: 'Product not found.' });
      }
      return res.json(mapProduct(row));
    }
    return next(error);
  }
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const {
    name,
    category,
    description,
    price,
    imageUrl,
    stock,
    discountPercent,
    discountStart,
    discountEnd,
  } = req.body || {};
  if (!name || !category || !description || price == null || stock == null || !imageUrl) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const parsedPrice = Number(price);
  const parsedStock = Number(stock);
  if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ error: 'Invalid product price.' });
  }
  if (!Number.isFinite(parsedStock) || parsedStock < 0) {
    return res.status(400).json({ error: 'Invalid stock value.' });
  }
  const parsedDiscount = Number(discountPercent ?? 0);
  const discount = Number.isFinite(parsedDiscount)
    ? Math.max(0, Math.min(90, parsedDiscount))
    : 0;
  const nextStart = discountStart ? new Date(discountStart) : null;
  const nextEnd = discountEnd ? new Date(discountEnd) : null;
  if ((nextStart && Number.isNaN(nextStart.getTime())) || (nextEnd && Number.isNaN(nextEnd.getTime()))) {
    return res.status(400).json({ error: 'Invalid discount date.' });
  }
  if (nextStart && nextEnd && nextEnd < nextStart) {
    return res.status(400).json({ error: 'Discount end date must be after start date.' });
  }

  const id = `p${Date.now()}`;
  const row = await prisma.product.create({
    data: {
      id,
      name,
      category,
      description,
      price: parsedPrice,
      discountPercent: discount,
      discountStart: nextStart,
      discountEnd: nextEnd,
      imageUrl,
      stock: Math.trunc(parsedStock),
      isActive: true,
    },
  });

  return res.status(201).json(mapProduct(row));
});

router.post('/import', requireAuth, requireRole('admin'), async (req, res) => {
  const csv = req.body?.csv?.toString() ?? '';
  if (!csv.trim()) {
    return res.status(400).json({ error: 'CSV content is required.' });
  }

  let parsedRows;
  try {
    parsedRows = parseCsv(csv);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (parsedRows.length === 0) {
    return res.status(400).json({ error: 'No product rows were found.' });
  }

  const normalizedRows = [];

  try {
    for (let index = 0; index < parsedRows.length; index += 1) {
      const row = parsedRows[index];
      const line = index + 2;

      const name = row.name?.trim();
      const category = row.category?.trim();
      const description = row.description?.trim();
      const imageUrl = row.imageUrl?.trim();

      if (!name || !category || !description || !imageUrl) {
        return res.status(400).json({
          error: `Row ${line} is missing one of the required fields: name, category, description, imageUrl.`,
        });
      }

      const price = Number(row.price);
      const stock = Number(row.stock);
      const discountPercent = Number(row.discountPercent ?? 0);

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: `Row ${line} has an invalid price.` });
      }

      if (!Number.isFinite(stock) || stock < 0) {
        return res.status(400).json({ error: `Row ${line} has an invalid stock value.` });
      }

      if (!Number.isFinite(discountPercent) || discountPercent < 0) {
        return res.status(400).json({
          error: `Row ${line} has an invalid discountPercent value.`,
        });
      }

      normalizedRows.push({
        id: row.id?.trim() || `p_${randomUUID()}`,
        name,
        category,
        description,
        price,
        stock: Math.trunc(stock),
        imageUrl,
        isActive: parseOptionalBoolean(row.isActive, true),
        discountPercent: Math.max(0, Math.min(90, discountPercent)),
        discountStart: parseOptionalDate(row.discountStart, line, 'discountStart'),
        discountEnd: parseOptionalDate(row.discountEnd, line, 'discountEnd'),
      });
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    await prisma.$transaction(
      normalizedRows.map((row) =>
        prisma.product.create({
          data: row,
        }),
      ),
    );
  } catch (error) {
    const message = error?.code === 'P2002'
      ? 'A product ID in the CSV already exists.'
      : 'Failed to import products.';
    return res.status(400).json({ error: message });
  }

  return res.status(201).json({ importedCount: normalizedRows.length });
});

router.post('/restock/import', requireAuth, requireRole('admin'), async (req, res) => {
  const csv = req.body?.csv?.toString() ?? '';
  if (!csv.trim()) {
    return res.status(400).json({ error: 'CSV content is required.' });
  }

  let parsedRows;
  try {
    parsedRows = parseCsv(csv);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (parsedRows.length === 0) {
    return res.status(400).json({ error: 'No inventory rows were found.' });
  }

  const normalizedRows = [];
  const productIds = new Set();

  for (let index = 0; index < parsedRows.length; index += 1) {
    const row = parsedRows[index];
    const line = index + 2;
    const productId = row.productId?.trim();
    const rawQuantity = row.quantityAdded?.trim() || row.quantity?.trim();

    if (!productId) {
      return res.status(400).json({ error: `Row ${line} is missing productId.` });
    }

    const quantityAdded = Number(rawQuantity);
    if (!Number.isFinite(quantityAdded) || quantityAdded <= 0 || !Number.isInteger(quantityAdded)) {
      return res.status(400).json({
        error: `Row ${line} has an invalid quantityAdded value.`,
      });
    }

    normalizedRows.push({
      productId,
      quantityAdded,
    });
    productIds.add(productId);
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...productIds] } },
  });
  const productMap = new Map(products.map((product) => [product.id, product]));

  for (const row of normalizedRows) {
    if (!productMap.has(row.productId)) {
      return res.status(404).json({
        error: `Product ${row.productId} was not found.`,
      });
    }
  }

  const operations = [];
  for (const row of normalizedRows) {
    const product = productMap.get(row.productId);
    const nextStock = product.stock + row.quantityAdded;

    operations.push(
      prisma.product.update({
        where: { id: product.id },
        data: { stock: nextStock },
      })
    );
    operations.push(
      prisma.restock.create({
        data: {
          productId: product.id,
          quantityAdded: row.quantityAdded,
        },
      })
    );

    productMap.set(product.id, {
      ...product,
      stock: nextStock,
    });
  }

  await prisma.$transaction(operations);
  return res.status(201).json({ importedCount: normalizedRows.length });
});

router.put('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const {
    name,
    category,
    description,
    price,
    imageUrl,
    stock,
    isActive,
    discountPercent,
    discountStart,
    discountEnd,
  } = req.body || {};
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Product not found.' });
  }
  let discount = existing.discountPercent;
  if (discountPercent != null) {
    const parsed = Number(discountPercent);
    discount = Number.isFinite(parsed) ? Math.max(0, Math.min(90, parsed)) : 0;
  }
  const nextStart =
    discountStart === undefined
      ? existing.discountStart
      : discountStart
      ? new Date(discountStart)
      : null;
  const nextEnd =
    discountEnd === undefined
      ? existing.discountEnd
      : discountEnd
      ? new Date(discountEnd)
      : null;
  if ((nextStart && Number.isNaN(nextStart.getTime())) || (nextEnd && Number.isNaN(nextEnd.getTime()))) {
    return res.status(400).json({ error: 'Invalid discount date.' });
  }
  if (nextStart && nextEnd && nextEnd < nextStart) {
    return res.status(400).json({ error: 'Discount end date must be after start date.' });
  }

  const nextPrice = price == null ? existing.price : Number(price);
  const nextStock = stock == null ? existing.stock : Number(stock);
  if (!Number.isFinite(nextPrice) || nextPrice < 0) {
    return res.status(400).json({ error: 'Invalid product price.' });
  }
  if (!Number.isFinite(nextStock) || nextStock < 0) {
    return res.status(400).json({ error: 'Invalid stock value.' });
  }

  const row = await prisma.product.update({
    where: { id: req.params.id },
    data: {
      name: name ?? existing.name,
      category: category ?? existing.category,
      description: description ?? existing.description,
      price: nextPrice,
      discountPercent: discount,
      imageUrl: imageUrl ?? existing.imageUrl,
      stock: Math.trunc(nextStock),
      isActive: isActive == null ? existing.isActive : Boolean(isActive),
      discountStart: nextStart,
      discountEnd: nextEnd,
    },
  });

  return res.json(mapProduct(row));
});

router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  const orderLineCount = await prisma.orderLine.count({
    where: { productId: req.params.id },
  });

  // Preserve products that already appear in orders so historical invoices
  // and sales reports stay consistent. They get archived instead of deleted.
  if (orderLineCount > 0) {
    const archived = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        isActive: false,
        stock: 0,
      },
    });

    await prisma.$transaction([
      prisma.favorite.deleteMany({ where: { productId: req.params.id } }),
    ]);

    return res.json({
      archived: true,
      product: mapProduct(archived),
      message: 'Product was archived because it has order history.',
    });
  }

  await prisma.$transaction([
    prisma.favorite.deleteMany({ where: { productId: req.params.id } }),
    prisma.productComment.deleteMany({ where: { productId: req.params.id } }),
    prisma.productRating.deleteMany({ where: { productId: req.params.id } }),
    prisma.restock.deleteMany({ where: { productId: req.params.id } }),
    prisma.product.delete({ where: { id: req.params.id } }),
  ]);
  return res.status(204).send();
});

router.post('/:id/restock', requireAuth, requireRole('admin'), async (req, res) => {
  const { quantity } = req.body || {};
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return res.status(400).json({ error: 'Quantity must be a whole number greater than 0.' });
  }

  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  await prisma.$transaction([
    prisma.product.update({
      where: { id: req.params.id },
      data: { stock: existing.stock + qty },
    }),
    prisma.restock.create({
      data: {
        productId: existing.id,
        quantityAdded: qty,
      },
    }),
  ]);

  const row = await prisma.product.findUnique({ where: { id: req.params.id } });
  return res.json(mapProduct(row));
});

function mapProduct(row) {
  const now = new Date();
  const start = row.discountStart ? new Date(row.discountStart) : null;
  const end = row.discountEnd ? new Date(row.discountEnd) : null;
  const isActive =
    row.discountPercent > 0 &&
    (!start || start <= now) &&
    (!end || end >= now);
  const effectiveDiscount = isActive ? row.discountPercent : 0;

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    price: row.price,
    discountPercent: row.discountPercent ?? 0,
    discountStart: row.discountStart,
    discountEnd: row.discountEnd,
    discountActive: isActive,
    effectiveDiscountPercent: effectiveDiscount,
    ratingAvg: row.ratingAvg ?? 0,
    ratingCount: row.ratingCount ?? 0,
    imageUrl: row.imageUrl,
    stock: row.stock,
    isActive: row.isActive,
  };
}

function parseOptionalDate(value, line, fieldName) {
  if (value == null || value.toString().trim() === '') {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Row ${line} has an invalid ${fieldName} date.`);
  }
  return parsed;
}

function parseOptionalBoolean(value, fallback) {
  if (value == null || value.toString().trim() === '') {
    return fallback;
  }

  const normalized = value.toString().trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseCsv(content) {
  const rows = [];
  let currentRow = [];
  let currentValue = '';
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentValue += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      currentRow.push(currentValue);
      if (currentRow.some((value) => value.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += char;
  }

  currentRow.push(currentValue);
  if (currentRow.some((value) => value.trim().length > 0)) {
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((value, index) => {
    const cleaned = value.trim();
    return index == 0 ? cleaned.replace(/^\\uFEFF/, '') : cleaned;
  });
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) {
        record[header] = row[index]?.trim() ?? '';
      }
    });
    return record;
  });
}

export default router;

