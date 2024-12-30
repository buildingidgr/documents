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
  try {
    console.log('Update request received:', {
      documentId,
      userId,
      body,
      timestamp: new Date().toISOString()
    });

    // Validate input
    const validatedInput = updateDocumentSchema.parse(body);

    // Check if document exists first
    const documentExists = await db.document.findUnique({
      where: {
        id: documentId
      }
    });

    console.log('Document existence check:', {
      documentId,
      exists: !!documentExists,
      timestamp: new Date().toISOString()
    });

    if (!documentExists) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Then check user access
    const userAccess = await db.document.findFirst({
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
      },
    });

    console.log('User access check:', {
      documentId,
      userId,
      hasAccess: !!userAccess,
      timestamp: new Date().toISOString()
    });

    if (!userAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create new version if content is updated
    const updateData: Prisma.DocumentUpdateInput = {
      ...(validatedInput.title && { title: validatedInput.title }),
      users: {
        connect: userAccess.users.map(user => ({ id: user.id }))
      }
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

    console.log('Updating document:', {
      documentId,
      userId,
      updateData,
      timestamp: new Date().toISOString()
    });

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

    console.log('Document updated successfully:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json(updatedDocument);
  } catch (error) {
    console.error('Error updating document:', {
      documentId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });

    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid request data',
        details: error.errors
      });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Document not found' });
      }
    }

    return res.status(500).json({ error: 'Failed to update document' });
  }
}

async function handleDelete(documentId: string, userId: string, res: NextApiResponse) {
  try {
    console.log('Attempting to delete document:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

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
      include: {
        users: true,
        versions: {
          select: {
            id: true
          }
        }
      }
    });

    if (!document) {
      console.log('Document not found or access denied:', {
        documentId,
        userId,
        timestamp: new Date().toISOString()
      });
      return res.status(404).json({ error: 'Document not found' });
    }

    // First, delete all relationships
    await db.$transaction([
      // Delete user relationships
      db.document.update({
        where: { id: documentId },
        data: {
          users: {
            disconnect: document.users.map(user => ({ id: user.id }))
          }
        }
      }),
      // Delete versions
      db.version.deleteMany({
        where: { documentId }
      }),
      // Finally, delete the document
      db.document.delete({
        where: { id: documentId }
      })
    ]);

    console.log('Document deleted successfully:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

    return res.status(204).end();
  } catch (error) {
    console.error('Error deleting document:', {
      documentId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });

    // Check for specific Prisma errors
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Document not found' });
      }
      if (error.code === 'P2003') {
        return res.status(400).json({ error: 'Cannot delete document due to existing references' });
      }
    }

    return res.status(500).json({ error: 'Failed to delete document' });
  }
} 