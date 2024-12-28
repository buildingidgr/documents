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
        name: null, // Can be updated later
      },
    });

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);

    // Create document
    console.log('Creating document for user:', user.id);
    
    // Create document with associations in a single operation
    const newDocument = await db.document.create({
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
      },
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

    // Log the full document with associations for debugging
    console.log('Created document with associations:', JSON.stringify({
      id: newDocument.id,
      title: newDocument.title,
      users: newDocument.users,
      versions: newDocument.versions
    }, null, 2));

    // Double check the associations were created
    const verifiedDoc = await db.document.findUnique({
      where: { id: newDocument.id },
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

    if (!verifiedDoc) {
      throw new Error('Document not found after creation');
    }

    if (!verifiedDoc.users.some(u => u.id === user.id)) {
      console.error('User association missing:', {
        documentId: verifiedDoc.id,
        userId: user.id,
        foundUsers: verifiedDoc.users
      });
      throw new Error('User association not created');
    }

    return res.status(200).json(verifiedDoc);
  } catch (err: unknown) {
    console.error('Error creating document:', err);
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid document format',
        details: err.errors 
      });
    }
    
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const error = err as Prisma.PrismaClientKnownRequestError;
      return res.status(500).json({ error: `Database error: ${error.message}` });
    }
    
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
} 