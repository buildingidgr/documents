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
    // Configure connection pool
    connection: {
      pool: {
        min: 2,
        max: 10
      }
    },
    // Add retry logic
    __internal: {
      engine: {
        retry: {
          maxRetries: 3,
          retryDelay: 1000, // 1s between retries
          retryOnError: true
        },
        connectionTimeout: 5000, // 5s connection timeout
        requestTimeout: 10000 // 10s request timeout
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

