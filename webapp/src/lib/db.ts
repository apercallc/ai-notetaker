import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Standard Next.js dev-mode singleton: hot-reload re-evaluates this module
// on every change, and without caching the client on `globalThis` each
// reload would open a fresh Postgres connection pool until the old ones
// leak past their limit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "", connectionTimeoutMillis: 5_000 }),
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
