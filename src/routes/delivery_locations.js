import { Router } from 'express';

import prisma from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  DeliveryLocationValidationError,
  listSavedDeliveryLocations,
  saveDeliveryLocation,
} from '../services/delivery_locations.js';

const router = Router();

function findLocationById(locations, id) {
  return locations.find((entry) => entry.id === id) ?? null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await listSavedDeliveryLocations(req.user.id, {
      hydrateFromOrders: true,
    });
    return res.json({ data });
  } catch (error) {
    console.error('Load saved delivery locations failed:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const location = await saveDeliveryLocation({
      userId: req.user.id,
      address: req.body?.address,
      latitude: req.body?.latitude,
      longitude: req.body?.longitude,
      placeLabel: req.body?.placeLabel,
      makeDefault: req.body?.makeDefault !== false,
    });

    const data = await listSavedDeliveryLocations(req.user.id);
    const created = findLocationById(data, location.id);
    return res.status(201).json({ data: created, locations: data });
  } catch (error) {
    if (error instanceof DeliveryLocationValidationError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Save delivery location failed:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.patch('/:id/default', requireAuth, async (req, res) => {
  const locationId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    return res.status(400).json({ error: 'Invalid delivery location.' });
  }

  try {
    const existing = await prisma.deliveryLocation.findFirst({
      where: { id: locationId, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Delivery location not found.' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.deliveryLocation.updateMany({
        where: { userId: req.user.id, id: { not: locationId } },
        data: { isDefault: false },
      });
      await tx.deliveryLocation.update({
        where: { id: locationId },
        data: { isDefault: true },
      });
    });

    const data = await listSavedDeliveryLocations(req.user.id);
    return res.json({
      data: findLocationById(data, locationId),
      locations: data,
    });
  } catch (error) {
    console.error('Set default delivery location failed:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
