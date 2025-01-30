import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma, User } from '@prisma/client';

// Plate.js content schema
const plateContentSchema = z.object({
  type: z.literal('doc'),
  content: z.array(
    z.object({
      type: z.string(),
    }).passthrough() // Allow any additional properties
  ),
});

const documentInputSchema = z.object({
  title: z.string(),
  content: plateContentSchema,
});

type DocumentInput = z.infer<typeof documentInputSchema>;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      message: 'Only POST method is allowed for this endpoint'
    });
  }

  try {
    // Check if Authorization header exists
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ 
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
        message: 'No authorization header provided'
      });
    }

    // Check Bearer token format
    const token = authHeader.split(' ')[1];
    if (!token || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Invalid authentication format',
        code: 'INVALID_AUTH_FORMAT',
        message: 'Authorization header must use Bearer scheme'
      });
    }

    console.log('[Document Create] Starting authentication');
    
    try {
      const userId = await authenticateUser(token);
      console.log('[Document Create] User authenticated:', userId);

      // Validate input
      try {
        const validatedInput = documentInputSchema.parse(req.body);
        console.log('[Document Create] Starting document creation for user:', userId);

        try {
          // Check Version table existence before transaction
          console.log('[DEBUG] Pre-transaction: Checking Version table...');
          const versionTableCheck = await db.$queryRaw`
            SELECT EXISTS (
              SELECT 1 
              FROM information_schema.tables 
              WHERE table_schema = current_schema()
              AND table_name = 'Version'
            ) as "exists";
          `;
          console.log('[DEBUG] Pre-transaction: Version table check result:', versionTableCheck);

          const schemaCheck = await db.$queryRaw`
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'Version'
            AND table_schema = current_schema();
          `;
          console.log('[DEBUG] Pre-transaction: Version table schema:', schemaCheck);

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
                  },
                  versions: {
                    create: {
                      content: validatedInput.content as Prisma.InputJsonValue,
                      user: { connect: { id: userId } }
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
                    }
                  }
                }
              });

              console.log('[Document Create] Created document:', doc.id);

              return doc;
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

          return res.status(201).json(result);
        } catch (dbError) {
          if (dbError instanceof Prisma.PrismaClientKnownRequestError) {
            // Handle specific Prisma errors
            switch (dbError.code) {
              case 'P2002':
                return res.status(409).json({
                  error: 'Document already exists',
                  code: 'DOCUMENT_EXISTS',
                  message: 'A document with this identifier already exists'
                });
              case 'P2025':
                return res.status(404).json({
                  error: 'User not found',
                  code: 'USER_NOT_FOUND',
                  message: 'The specified user does not exist'
                });
              case 'P2034':
                // Transaction timed out, suggest retry
                return res.status(503).json({ 
                  error: 'Transaction timed out',
                  code: 'TRANSACTION_TIMEOUT',
                  message: 'Please try again',
                  retryAfter: 1
                });
              default:
                console.error('[Document Create] Database error:', dbError.message);
                return res.status(500).json({
                  error: 'Database operation failed',
                  code: 'DATABASE_ERROR',
                  message: 'Failed to create document due to a database error'
                });
            }
          }
          
          // For connection errors, suggest retry
          if (dbError instanceof Prisma.PrismaClientRustPanicError || 
              dbError instanceof Prisma.PrismaClientInitializationError) {
            return res.status(503).json({ 
              error: 'Service temporarily unavailable',
              code: 'SERVICE_UNAVAILABLE',
              message: 'Please try again later',
              retryAfter: 2
            });
          }

          console.error('[Document Create] Unexpected database error:', dbError);
          return res.status(500).json({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred while creating the document'
          });
        }
      } catch (validationError) {
        if (validationError instanceof z.ZodError) {
          return res.status(400).json({ 
            error: 'Invalid document format',
            code: 'INVALID_FORMAT',
            message: 'The document format is invalid',
            details: validationError.errors
          });
        }
        throw validationError;
      }
    } catch (authError) {
      if (authError instanceof Error) {
        if (authError.message === 'Token expired') {
          return res.status(401).json({
            error: 'Token expired',
            code: 'TOKEN_EXPIRED',
            message: 'Authentication token has expired'
          });
        }
        if (authError.message === 'Invalid token') {
          return res.status(401).json({
            error: 'Invalid token',
            code: 'INVALID_TOKEN',
            message: 'Authentication token is invalid'
          });
        }
      }
      return res.status(401).json({
        error: 'Authentication failed',
        code: 'AUTH_FAILED',
        message: 'Failed to authenticate user'
      });
    }
  } catch (err) {
    console.error('[Document Create] Unhandled error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    });
  }
} 