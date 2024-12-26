import type { NextApiRequest, NextApiResponse } from 'next'
import { prisma } from '../../server/db'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.status(200).json({ status: 'ok' })
  } catch (error) {
    console.error('Health check failed:', error)
    res.status(500).json({ status: 'error', message: 'Database connection failed' })
  }
}

