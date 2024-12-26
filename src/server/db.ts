import { PrismaClient } from '@prisma/client'

declare global {
  var prisma: PrismaClient | undefined
}

export const prisma = global.prisma || new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
})

if (process.env.NODE_ENV !== 'production') global.prisma = prisma

// Don't connect to the database during build time
if (process.env.NODE_ENV !== 'production') {
  prisma.$connect()
    .then(() => {
      console.log('Successfully connected to the database')
    })
    .catch((error) => {
      console.error('Failed to connect to the database:', error)
    })
}

export { prisma as db }

