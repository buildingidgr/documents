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
    console.log('[Document Create] Starting document creation for user:', userId);

    try {
      // Wrap all database operations in a single transaction with retries
      const result = await db.$transaction(
        async (tx) => {
          // Create document with user association
          const doc = await tx.document.create({
            data: {
              title: validatedInput.title,
              content: validatedInput.content as Prisma.InputJsonValue,
              users: {
                connect: { id: userId }
              }
            }
          });

          console.log('[Document Create] Created document:', doc.id);

          // Debug: Check if Version table exists
          const versionTableCheck = await tx.$queryRaw`
            SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_schema = 'public'
              AND table_name = 'Version'
            );
          `;
          console.log('[Document Create] Version table check:', versionTableCheck);

          // Create initial version with debug
          console.log('[Document Create] Attempting to create version...');
          const version = await tx.version.create({
            data: {
              content: validatedInput.content as Prisma.InputJsonValue,
              document: { connect: { id: doc.id } },
              user: { connect: { id: userId } }
            },
            select: {
              id: true,
              documentId: true,
              userId: true
            }
          });
          console.log('[Document Create] Created version:', version);

          // Fetch complete document with associations
          const fullDoc = await tx.document.findFirstOrThrow({
            where: { 
              id: doc.id,
              users: {
                some: {
                  id: userId
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
                select: {
                  id: true,
                  content: true,
                  createdAt: true,
                  userId: true,
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

          // Verify version was created
          if (!fullDoc.versions || fullDoc.versions.length === 0) {
            throw new Error('Version was not created');
          }

          return fullDoc;
        },
        {
          maxWait: 5000,
          timeout: 10000,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }
      );

      console.log('[Document Create] Transaction completed successfully:', {
        documentId: result.id,
        userId: userId,
        versionCount: result.versions?.length ?? 0
      });

      return res.status(200).json(result);
    } catch (dbError) {
      if (dbError instanceof Prisma.PrismaClientKnownRequestError) {
        // Handle specific Prisma errors
        switch (dbError.code) {
          case 'P2002':
            return res.status(409).json({ error: 'Document already exists' });
          case 'P2025':
            return res.status(404).json({ error: 'User not found' });
          case 'P2034':
            // Transaction timed out, suggest retry
            return res.status(503).json({ 
              error: 'Transaction timed out, please try again',
              retryAfter: 1
            });
          default:
            console.error('[Document Create] Database error:', dbError.message);
            return res.status(500).json({ error: 'Database operation failed' });
        }
      }
      
      // For connection errors, suggest retry
      if (dbError instanceof Prisma.PrismaClientRustPanicError || 
          dbError instanceof Prisma.PrismaClientInitializationError) {
        return res.status(503).json({ 
          error: 'Service temporarily unavailable, please try again',
          retryAfter: 2
        });
      }

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