import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Plate.js content schema (same as create endpoint)
const plateContentSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      content: z.array(z.any()).optional(),
    })).optional(),
  })),
});

const updateDocumentSchema = z.object({
  title: z.string().optional(),
  content: plateContentSchema.optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('[DEBUG] Document GET request received:', {
    method: req.method,
    documentId: req.query.id,
    headers: req.headers,
  });

  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    console.log('[DEBUG] Token:', token ? 'Present' : 'Missing');
    
    const userId = await authenticateUser(token);
    console.log('[DEBUG] User authenticated:', userId);
    
    const documentId = req.query.id as string;
    console.log('[DEBUG] Looking up document:', documentId);
    
    switch (req.method) {
      case 'GET':
        return handleGet(documentId, userId, res);
      case 'PUT':
        return handleUpdate(documentId, userId, req.body, res);
      case 'DELETE':
        return handleDelete(documentId, userId, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err: unknown) {
    console.error('Error handling document request:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(documentId: string, userId: string, res: NextApiResponse) {
  const document = await db.document.findFirst({
    where: {
      id: documentId,
      users: {
        some: {
          id: userId,
        },
      },
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
          content: true,
          createdAt: true,
        },
      },
    },
  });

  if (!document) {
    return res.status(404).json({ error: 'Document not found' });
  }

  return res.status(200).json(document);
}

async function handleUpdate(
  documentId: string,
  userId: string,
  body: any,
  res: NextApiResponse
) {
  // Validate input
  const validatedInput = updateDocumentSchema.parse(body);

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

  // Create new version if content is updated
  const updateData: Prisma.DocumentUpdateInput = {
    ...(validatedInput.title && { title: validatedInput.title }),
  };

  if (validatedInput.content) {
    updateData.content = validatedInput.content as Prisma.InputJsonValue;
    updateData.versions = {
      create: {
        content: validatedInput.content as Prisma.InputJsonValue,
        user: { connect: { id: userId } },
      },
    };
  }

  const updatedDocument = await db.document.update({
    where: { id: documentId },
    data: updateData,
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
          content: true,
          createdAt: true,
        },
      },
    },
  });

  return res.status(200).json(updatedDocument);
}

async function handleDelete(documentId: string, userId: string, res: NextApiResponse) {
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

  // Delete document and all related data (versions will be cascade deleted)
  await db.document.delete({
    where: { id: documentId },
  });

  return res.status(204).end();
} 