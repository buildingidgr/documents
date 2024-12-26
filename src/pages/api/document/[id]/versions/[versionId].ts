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
    
    const documentId = req.query.id as string;
    const versionId = req.query.versionId as string;

    // Check document access
    const document = await db.document.findFirst({
      where: {
        id: documentId,
        users: {
          some: {
            id: userId,
          },
        },
      },
    });

    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Get specific version
    const version = await db.version.findFirst({
      where: {
        id: versionId,
        documentId: documentId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    return res.status(200).json(version);
  } catch (err: unknown) {
    console.error('Error fetching version:', err);
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
} 