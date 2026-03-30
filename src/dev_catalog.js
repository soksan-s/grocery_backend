const demoCatalogRows = [
  {
    id: 'demo_apples',
    name: 'Fresh Apples',
    category: 'Fruits',
    description: 'Crisp red apples with a sweet finish.',
    price: 3.25,
    discountPercent: 10,
    discountStart: '2026-03-01T00:00:00.000Z',
    discountEnd: '2026-12-31T23:59:59.000Z',
    ratingAvg: 4.8,
    ratingCount: 12,
    imageUrl: 'https://picsum.photos/seed/demo-apples/900/500',
    stock: 40,
    isActive: true,
  },
  {
    id: 'demo_milk',
    name: 'Whole Milk',
    category: 'Dairy',
    description: '1L whole milk from local farms.',
    price: 1.99,
    discountPercent: 0,
    discountStart: null,
    discountEnd: null,
    ratingAvg: 4.5,
    ratingCount: 7,
    imageUrl: 'https://picsum.photos/seed/demo-milk/900/500',
    stock: 30,
    isActive: true,
  },
  {
    id: 'demo_rice',
    name: 'Basmati Rice',
    category: 'Grains',
    description: 'Premium long-grain basmati rice, 5kg bag.',
    price: 12.5,
    discountPercent: 5,
    discountStart: '2026-03-01T00:00:00.000Z',
    discountEnd: '2026-12-31T23:59:59.000Z',
    ratingAvg: 4.7,
    ratingCount: 4,
    imageUrl: 'https://picsum.photos/seed/demo-rice/900/500',
    stock: 18,
    isActive: true,
  },
  {
    id: 'demo_chicken',
    name: 'Chicken Breast',
    category: 'Meat',
    description: 'Boneless chicken breast, approx. 500g tray.',
    price: 5.4,
    discountPercent: 0,
    discountStart: null,
    discountEnd: null,
    ratingAvg: 4.4,
    ratingCount: 5,
    imageUrl: 'https://picsum.photos/seed/demo-chicken/900/500',
    stock: 22,
    isActive: true,
  },
];

export function getFallbackProducts({ includeInactive = false } = {}) {
  const filtered = includeInactive
    ? demoCatalogRows
    : demoCatalogRows.filter((row) => row.isActive);
  return filtered.map((row) => ({ ...row }));
}

export function getFallbackProductById(id) {
  const row = demoCatalogRows.find((item) => item.id === id);
  return row ? { ...row } : null;
}

export function getFallbackCategories() {
  return [...new Set(demoCatalogRows
    .filter((row) => row.isActive)
    .map((row) => row.category))].sort((left, right) => left.localeCompare(right));
}

export function isDatabaseUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('Environment variable not found: DATABASE_URL') ||
    message.includes('Can\'t reach database server') ||
    message.includes('Error validating datasource') ||
    message.includes('PrismaClientInitializationError')
  );
}
