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
    ]
  });

  // Handle disconnection
  client.$connect()
    .then(() => {
      console.log('Successfully connected to database');
    })
    .catch((error: Error) => {
      console.error('Failed to connect to database:', error.message);
    });

  return client;
}

// Ensure singleton instance
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// In development, prevent hot-reload from creating new instances
export const prisma = globalForPrisma.prisma ?? prismaClientSingleton()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// Export both named and default for flexibility
export { prisma as db }
export default prisma

