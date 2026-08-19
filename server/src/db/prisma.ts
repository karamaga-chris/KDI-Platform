import { PrismaClient } from '@prisma/client';

/** Single Prisma instance reused across the app (avoids connection exhaustion). */
export const prisma = new PrismaClient();
