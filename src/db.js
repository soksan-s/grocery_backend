import { PrismaClient } from '@prisma/client';

const prismaGlobal = globalThis;
const prisma = prismaGlobal.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  prismaGlobal.__prisma = prisma;
}

export default prisma;
