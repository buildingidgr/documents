import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';

const collaboratorSchema = z.object({
  userId: z.string(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);
    
    const documentId = req.query.id as string;

    // Check document ownership
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

    switch (req.method) {
      case 'GET':
        return handleGet(documentId, res);
      case 'POST':
        return handleAdd(documentId, req.body, res);
      case 'DELETE':
        return handleRemove(documentId, req.body, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err: unknown) {
    console.error('Error handling collaborators:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
}

async function handleGet(documentId: string, res: NextApiResponse) {
  const collaborators = await db.user.findMany({
    where: {
      documents: {
        some: {
          id: documentId,
        },
      },
    },
    select: {
      id: true,
      name: true,
    },
  });

  return res.status(200).json(collaborators);
}

async function handleAdd(documentId: string, body: any, res: NextApiResponse) {
  const { userId } = collaboratorSchema.parse(body);

  // Check if user exists
  const user = await db.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Add collaborator
  await db.document.update({
    where: { id: documentId },
    data: {
      users: {
        connect: { id: userId },
      },
    },
  });

  return res.status(200).json({ message: 'Collaborator added successfully' });
}

async function handleRemove(documentId: string, body: any, res: NextApiResponse) {
  const { userId } = collaboratorSchema.parse(body);

  // Remove collaborator
  await db.document.update({
    where: { id: documentId },
    data: {
      users: {
        disconnect: { id: userId },
      },
    },
  });

  return res.status(200).json({ message: 'Collaborator removed successfully' });
} 