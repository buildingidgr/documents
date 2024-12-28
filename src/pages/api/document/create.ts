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
    const newDocument = await db.$transaction(async (tx) => {
      // Create the document first
      const doc = await tx.document.create({
        data: {
          title: validatedInput.title,
          content: validatedInput.content as Prisma.InputJsonValue,
        }
      });

      // Create version
      await tx.version.create({
        data: {
          content: validatedInput.content as Prisma.InputJsonValue,
          document: { connect: { id: doc.id } },
          user: { connect: { id: user.id } }
        }
      });

      // Create user association
      await tx.document.update({
        where: { id: doc.id },
        data: {
          users: {
            connect: { id: user.id }
          }
        },
        include: {
          users: true,
          versions: {
            orderBy: {
              createdAt: 'desc'
            },
            take: 1,
            include: {
              user: true
            }
          }
        }
      });

      return doc;
    });

    console.log('Created document:', {
      id: newDocument.id,
      title: newDocument.title
    });

    // Verify the association was created
    const verifiedDoc = await db.document.findUnique({
      where: { id: newDocument.id },
      include: {
        users: true,
        versions: {
          orderBy: {
            createdAt: 'desc'
          },
          take: 1,
          include: {
            user: true
          }
        }
      }
    });

    if (!verifiedDoc?.users.some(u => u.id === user.id)) {
      throw new Error('Failed to create user association');
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