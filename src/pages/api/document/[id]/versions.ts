import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Version content schema (same as document content)
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

const createVersionSchema = z.object({
  content: plateContentSchema,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);
    
    const documentId = req.query.id as string;

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

    switch (req.method) {
      case 'GET':
        return handleGet(documentId, req.query, res);
      case 'POST':
        return handleCreate(documentId, userId, req.body, res);
      default:
        return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err: unknown) {
    console.error('Error handling versions:', err);
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: err.errors });
    }
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
}

async function handleGet(documentId: string, query: any, res: NextApiResponse) {
  const page = Number(query.page) || 1;
  const limit = Number(query.limit) || 10;
  const skip = (page - 1) * limit;

  const versions = await db.version.findMany({
    where: {
      documentId,
    },
    orderBy: {
      createdAt: 'desc',
    },
    skip,
    take: limit,
    include: {
      user: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const total = await db.version.count({
    where: {
      documentId,
    },
  });

  return res.status(200).json({
    versions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

async function handleCreate(documentId: string, userId: string, body: any, res: NextApiResponse) {
  const validatedInput = createVersionSchema.parse(body);

  // Create new version
  const version = await db.version.create({
    data: {
      content: validatedInput.content as Prisma.InputJsonValue,
      document: { connect: { id: documentId } },
      user: { connect: { id: userId } },
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

  // Update document content
  await db.document.update({
    where: { id: documentId },
    data: {
      content: validatedInput.content as Prisma.InputJsonValue,
    },
  });

  return res.status(201).json(version);
} 