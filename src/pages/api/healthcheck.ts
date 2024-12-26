import type { NextApiRequest, NextApiResponse } from 'next'
import { prisma } from '../../server/db'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: 'healthy' });
  } catch (error) {
    console.error('Healthcheck failed:', error);
    return res.status(500).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
}

