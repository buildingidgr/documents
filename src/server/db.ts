import { PrismaClient } from '@prisma/client'

declare global {
  var prisma: PrismaClient | undefined
}

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: ['query', 'error', 'warn'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    },
    // Configure client behavior
    __internal: {
      engine: {
        connectTimeout: 5000, // 5s connection timeout
        requestTimeout: 10000, // 10s request timeout
        retry: {
          maxRetries: 3,
          backoff: {
            type: 'exponential',
            minDelay: 1000, // 1s minimum delay
            maxDelay: 5000  // 5s maximum delay
          }
        }
      }
    }
  })
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? prismaClientSingleton()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export { prisma as db }

