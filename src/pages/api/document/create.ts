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

    // Ensure user exists in database
    process.stdout.write(`[Document Create] Creating/updating user: ${userId}\n`);
    const user = await db.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        name: null,
      },
    });
    process.stdout.write(`[Document Create] User operation result: ${JSON.stringify(user)}\n`);

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);
    process.stdout.write(`[Document Create] Validated input: ${JSON.stringify(validatedInput)}\n`);

    try {
      // Create document with associations
      process.stdout.write(`[Document Create] Creating document for user: ${user.id}\n`);
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
      process.stdout.write(`[Document Create] Initial document creation result: ${JSON.stringify(doc)}\n`);

      // Fetch the complete document with associations
      process.stdout.write(`[Document Create] Fetching complete document: ${doc.id}\n`);
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
      process.stdout.write(`[Document Create] Document with associations: ${JSON.stringify(documentWithAssociations)}\n`);

      if (!documentWithAssociations) {
        process.stderr.write(`[Document Create] Error: Document not found after creation: ${doc.id}\n`);
        throw new Error('Document not found after creation');
      }

      // Verify user association
      const hasUserAssociation = documentWithAssociations.users.some((u: User) => u.id === user.id);
      process.stdout.write(`[Document Create] User association check: ${JSON.stringify({
        documentId: doc.id,
        userId: user.id,
        hasAssociation: hasUserAssociation,
        associatedUsers: documentWithAssociations.users
      })}\n`);

      if (!hasUserAssociation) {
        process.stderr.write(`[Document Create] Error: User association missing, attempting direct query\n`);
        // Double check with direct query
        const userAssoc = await db.$queryRaw`
          SELECT * FROM "_DocumentToUser" 
          WHERE "A" = ${doc.id} AND "B" = ${user.id}
        `;
        process.stdout.write(`[Document Create] Direct user association query result: ${JSON.stringify(userAssoc)}\n`);
      }

      // Return the complete document
      return res.status(200).json({
        ...documentWithAssociations,
        users: documentWithAssociations.users,
        versions: documentWithAssociations.versions
      });
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