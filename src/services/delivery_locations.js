import prisma from '../db.js';

export class DeliveryLocationValidationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'DeliveryLocationValidationError';
    this.statusCode = statusCode;
  }
}

function normalizeText(value) {
  return (value ?? '').toString().trim();
}

function normalizeCoordinate(value, axis) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new DeliveryLocationValidationError(
      400,
      `Invalid ${axis} coordinate.`,
    );
  }

  if (axis === 'latitude' && (parsed < -90 || parsed > 90)) {
    throw new DeliveryLocationValidationError(400, 'Latitude is out of range.');
  }

  if (axis === 'longitude' && (parsed < -180 || parsed > 180)) {
    throw new DeliveryLocationValidationError(
      400,
      'Longitude is out of range.',
    );
  }

  return Number(parsed.toFixed(6));
}

function mapSavedLocation(row) {
  return {
    id: row.id,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    placeLabel: row.placeLabel ?? null,
    isDefault: row.isDefault === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function fetchSavedLocationRows(userId, client = prisma) {
  return client.deliveryLocation.findMany({
    where: { userId },
    orderBy: [
      { isDefault: 'desc' },
      { updatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });
}

export async function saveDeliveryLocation(
  {
    userId,
    address,
    latitude,
    longitude,
    placeLabel,
    makeDefault = true,
  },
  client = prisma,
) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new DeliveryLocationValidationError(400, 'Invalid user.');
  }

  const normalizedAddress = normalizeText(address);
  if (!normalizedAddress) {
    throw new DeliveryLocationValidationError(400, 'Address is required.');
  }

  const normalizedLatitude = normalizeCoordinate(latitude, 'latitude');
  const normalizedLongitude = normalizeCoordinate(longitude, 'longitude');
  const normalizedPlaceLabel = normalizeText(placeLabel) || null;

  const existing = await client.deliveryLocation.findUnique({
    where: {
      userId_latitude_longitude: {
        userId,
        latitude: normalizedLatitude,
        longitude: normalizedLongitude,
      },
    },
  });

  const currentDefault =
    existing?.isDefault === true
      ? existing
      : await client.deliveryLocation.findFirst({
          where: { userId, isDefault: true },
          select: { id: true },
        });
  const shouldMakeDefault = makeDefault || currentDefault == null;

  if (shouldMakeDefault) {
    await client.deliveryLocation.updateMany({
      where:
        existing == null
          ? { userId }
          : {
              userId,
              id: { not: existing.id },
            },
      data: { isDefault: false },
    });
  }

  if (existing != null) {
    return client.deliveryLocation.update({
      where: { id: existing.id },
      data: {
        address: normalizedAddress,
        placeLabel: normalizedPlaceLabel,
        isDefault: shouldMakeDefault ? true : existing.isDefault,
      },
    });
  }

  return client.deliveryLocation.create({
    data: {
      userId,
      address: normalizedAddress,
      latitude: normalizedLatitude,
      longitude: normalizedLongitude,
      placeLabel: normalizedPlaceLabel,
      isDefault: shouldMakeDefault,
    },
  });
}

export async function listSavedDeliveryLocations(
  userId,
  { hydrateFromOrders = false } = {},
  client = prisma,
) {
  let rows = await fetchSavedLocationRows(userId, client);

  if (rows.length === 0 && hydrateFromOrders) {
    const seenKeys = new Set();
    const historicOrders = await client.order.findMany({
      where: {
        customerId: userId,
        shippingLatitude: { not: null },
        shippingLongitude: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        shippingAddress: true,
        shippingLatitude: true,
        shippingLongitude: true,
        shippingPlaceLabel: true,
      },
      take: 12,
    });

    let makeDefault = true;
    for (const order of historicOrders) {
      const latitude = order.shippingLatitude;
      const longitude = order.shippingLongitude;
      if (latitude == null || longitude == null) {
        continue;
      }

      const key = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
      if (seenKeys.contains(key)) {
        continue;
      }

      seenKeys.add(key);
      await saveDeliveryLocation(
        {
          userId: userId,
          address: order.shippingAddress,
          latitude: latitude,
          longitude: longitude,
          placeLabel: order.shippingPlaceLabel,
          makeDefault: makeDefault,
        },
        client,
      );
      makeDefault = false;
    }

    rows = await fetchSavedLocationRows(userId, client);
  }

  return rows.map(mapSavedLocation);
}
