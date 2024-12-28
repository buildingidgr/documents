import { PrismaClient, Prisma } from '@prisma/client'

declare global {
  var prisma: PrismaClient | undefined
}

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    log: [
      {
        emit: 'stdout',
        level: 'query',
      },
      {
        emit: 'stdout',
        level: 'error',
      },
      {
        emit: 'stdout',
        level: 'warn',
      }
    ],
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });

  // Handle disconnection
  client.$connect()
    .then(() => {
      console.log('Successfully connected to database');
    })
    .catch((err) => {
      console.error('Failed to connect to database:', err);
      process.exit(1); // Force container restart on connection failure
    });

  // Cleanup on shutdown
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, async () => {
      console.log(`${signal} received, closing database connection`);
      await client.$disconnect();
      process.exit(0);
    });
  });

  return client;
}

// Ensure singleton instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? prismaClientSingleton()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// Export both as prisma and db for backward compatibility
export { prisma as db }
export default prisma

