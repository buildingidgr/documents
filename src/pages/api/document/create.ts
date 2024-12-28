import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Plate.js content schema
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

const documentInputSchema = z.object({
  title: z.string(),
  content: plateContentSchema,
});

type DocumentInput = z.infer<typeof documentInputSchema>;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);

    // Ensure user exists in database
    const user = await db.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        name: null,
      },
    });

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);

    // Create document with associations
    const doc = await db.document.create({
      data: {
        title: validatedInput.title,
        content: validatedInput.content as Prisma.InputJsonValue,
        users: {
          connect: { id: user.id }
        },
        versions: {
          create: {
            content: validatedInput.content as Prisma.InputJsonValue,
            user: { connect: { id: user.id } }
          }
        }
      }
    });

    // Fetch the complete document with associations
    const documentWithAssociations = await db.document.findUnique({
      where: { id: doc.id },
      include: {
        users: {
          select: {
            id: true,
            name: true
          }
        },
        versions: {
          include: {
            user: {
              select: {
                id: true,
                name: true
              }
            }
          },
          orderBy: {
            createdAt: 'desc'
          },
          take: 1
        }
      }
    });

    if (!documentWithAssociations) {
      throw new Error('Document not found after creation');
    }

    // Return the complete document
    return res.status(200).json({
      ...documentWithAssociations,
      users: documentWithAssociations.users,
      versions: documentWithAssociations.versions
    });
  } catch (err: unknown) {
    console.error('Error creating document:', err);
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid document format',
        details: err.errors 
      });
    }
    
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return res.status(500).json({ 
        error: `Database error: ${(err as Prisma.PrismaClientKnownRequestError).message}` 
      });
    }
    
    return res.status(500).json({ 
      error: err instanceof Error ? err.message : 'Internal server error' 
    });
  }
} 