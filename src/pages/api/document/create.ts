import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma, User } from '@prisma/client';

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

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);
    process.stdout.write(`[Document Create] Validated input: ${JSON.stringify(validatedInput)}\n`);

    try {
      // Wrap all database operations in a single transaction
      const result = await db.$transaction(async (tx) => {
        // Ensure user exists in database
        process.stdout.write(`[Document Create] Creating/updating user: ${userId}\n`);
        const user = await tx.user.upsert({
          where: { id: userId },
          update: {},
          create: {
            id: userId,
            name: null,
          },
        });
        process.stdout.write(`[Document Create] User operation result: ${JSON.stringify(user)}\n`);

        // Create document with associations
        process.stdout.write(`[Document Create] Creating document for user: ${user.id}\n`);
        const doc = await tx.document.create({
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
        process.stdout.write(`[Document Create] Document created with associations: ${JSON.stringify(doc)}\n`);

        return doc;
      }, {
        maxWait: 5000, // 5s max wait time
        timeout: 10000 // 10s timeout
      });

      if (!result.users.some((u: User) => u.id === userId)) {
        process.stderr.write(`[Document Create] Error: User association missing after transaction\n`);
        throw new Error('Failed to create user association');
      }

      return res.status(200).json(result);
    } catch (dbError) {
      process.stderr.write(`[Document Create] Database operation error: ${JSON.stringify(dbError)}\n`);
      throw dbError;
    }
  } catch (err: unknown) {
    console.error('Error creating document:', err);
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid document format',
        details: (err as z.ZodError).errors 
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