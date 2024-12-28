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
    console.log('Creating/updating user:', userId);
    const user = await db.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        name: null,
      },
    });
    console.log('User operation result:', JSON.stringify(user, null, 2));

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);
    console.log('Validated input:', JSON.stringify(validatedInput, null, 2));

    // Create document with associations
    console.log('Creating document with associations for user:', user.id);
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
    console.log('Initial document creation result:', JSON.stringify(doc, null, 2));

    // Fetch the complete document with associations
    console.log('Fetching complete document:', doc.id);
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
    console.log('Document with associations:', JSON.stringify(documentWithAssociations, null, 2));

    if (!documentWithAssociations) {
      console.error('Document not found after creation:', doc.id);
      throw new Error('Document not found after creation');
    }

    // Verify user association
    const hasUserAssociation = documentWithAssociations.users.some(u => u.id === user.id);
    console.log('User association check:', {
      documentId: doc.id,
      userId: user.id,
      hasAssociation: hasUserAssociation,
      associatedUsers: documentWithAssociations.users
    });

    if (!hasUserAssociation) {
      console.error('User association missing, attempting direct query');
      // Double check with direct query
      const userAssoc = await db.$queryRaw`
        SELECT * FROM "_DocumentToUser" 
        WHERE "A" = ${doc.id} AND "B" = ${user.id}
      `;
      console.log('Direct user association query result:', userAssoc);
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