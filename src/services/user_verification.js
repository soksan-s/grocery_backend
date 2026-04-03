import prisma from '../db.js';

const EMAIL_VERIFICATION_RELEASED_AT = new Date('2026-03-30T18:38:32.000Z');

export async function ensureLegacyPasswordUserVerified(user) {
  if (
    !user ||
    user.role === 'admin' ||
    user.emailVerified ||
    !user.passwordHash ||
    !user.email
  ) {
    return user;
  }

  const createdAt = user.createdAt instanceof Date ? user.createdAt : null;
  if (createdAt != null && createdAt < EMAIL_VERIFICATION_RELEASED_AT) {
    return prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
  }

  const existingVerificationRecord = await prisma.otpVerification.findFirst({
    where: {
      userId: user.id,
      type: 'email_verify',
    },
    select: { id: true },
  });

  if (existingVerificationRecord) {
    return user;
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true },
  });
}
