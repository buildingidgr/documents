import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);

    // Get all documents for user
    const documents = await db.document.findMany({
      where: {
        users: {
          some: {
            id: userId,
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      include: {
        users: {
          select: {
            id: true,
            name: true,
          },
        },
        versions: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
          select: {
            id: true,
            createdAt: true,
          },
        },
      },
    });

    return res.status(200).json(documents);
  } catch (err: unknown) {
    console.error('Error fetching documents:', err);
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
} 