import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Plate.js types
interface PlateText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  [key: string]: any; // For other formatting marks
}

interface PlateElement {
  type: string;
  children: (PlateElement | PlateText)[];
  [key: string]: any; // For other element attributes
}

interface PlateDocument {
  type: 'doc';
  content: PlateElement[];
}

// Validation schemas
const plateTextSchema: z.ZodType<PlateText> = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
}).passthrough(); // Allow other formatting marks

const plateElementSchema: z.ZodType<PlateElement> = z.lazy(() => 
  z.object({
    type: z.string(),
    children: z.array(z.union([plateElementSchema, plateTextSchema])),
  }).passthrough() // Allow other element attributes
);

const plateDocumentSchema: z.ZodType<PlateDocument> = z.object({
  type: z.literal('doc'),
  content: z.array(plateElementSchema),
});

const updateDocumentSchema = z.object({
  title: z.string().optional(),
  content: plateDocumentSchema.optional(),
});

// Validation helper
function validatePlateContent(content: unknown): content is PlateDocument {
  const validateElement = (element: unknown): boolean => {
    if (element && typeof element === 'object' && 'text' in element) {
      return typeof (element as PlateText).text === 'string';
    }
    
    if (
      element && 
      typeof element === 'object' && 
      'type' in element && 
      'children' in element
    ) {
      const elem = element as PlateElement;
      return typeof elem.type === 'string' && 
             Array.isArray(elem.children) &&
             elem.children.every(child => validateElement(child));
    }
    
    return false;
  };

  if (
    !content || 
    typeof content !== 'object' || 
    !('type' in content) || 
    !('content' in content) || 
    (content as PlateDocument).type !== 'doc' || 
    !Array.isArray((content as PlateDocument).content)
  ) {
    return false;
  }

  return (content as PlateDocument).content.every(element => validateElement(element));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('[DEBUG] Document request received:', {
    method: req.method,
    documentId: req.query.id,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });

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

    console.log('[DEBUG] Token:', 'Present');
    
    try {
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
  } catch (err: unknown) {
    console.error('Error handling document request:', {
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(documentId: string, userId: string, res: NextApiResponse) {
  try {
    console.log('Fetching document:', {
      documentId,
      userId,
      timestamp: new Date().toISOString()
    });

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
      // Check if document exists but user doesn't have access
      const documentExists = await db.document.findUnique({
        where: { id: documentId },
        select: { id: true }
      });

      if (documentExists) {
        return res.status(403).json({
          error: 'Access denied',
          code: 'ACCESS_DENIED',
          message: 'You do not have permission to access this document'
        });
      }

      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The requested document does not exist'
      });
    }

    // Log the document content for debugging
    console.log('Document content from database:', {
      documentId,
      content: document.content,
      timestamp: new Date().toISOString()
    });

    // Validate the content structure
    if (document.content && !validatePlateContent(document.content)) {
      console.warn('Invalid document content structure:', {
        documentId,
        content: document.content,
        timestamp: new Date().toISOString()
      });
    }

    // Ensure we're returning the actual content from the document
    const response = {
      ...document,
      content: document.content || {
        type: 'doc',
        content: [{ type: 'p', children: [{ text: '' }] }]
      }
    };

    console.log('Sending document response:', {
      documentId,
      hasContent: !!response.content,
      timestamp: new Date().toISOString()
    });

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching document:', {
      documentId,
      userId,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ error: 'Failed to fetch document' });
  }
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

    // Additional content validation if present
    if (validatedInput.content && !validatePlateContent(validatedInput.content)) {
      return res.status(400).json({ error: 'Invalid content structure' });
    }

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
      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The requested document does not exist'
      });
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
      return res.status(403).json({
        error: 'Access denied',
        code: 'ACCESS_DENIED',
        message: 'You do not have permission to modify this document'
      });
    }

    // Create new version if content is updated
    const updateData: Prisma.DocumentUpdateInput = {
      ...(validatedInput.title && { title: validatedInput.title }),
      users: {
        connect: userAccess.users.map(user => ({ id: user.id }))
      }
    };

    if (validatedInput.content) {
      console.log('Content update validation:', {
        documentId,
        content: validatedInput.content,
        timestamp: new Date().toISOString()
      });

      // Ensure content structure is preserved exactly as received
      const contentJson = JSON.parse(JSON.stringify(validatedInput.content)) as Prisma.InputJsonValue;
      updateData.content = contentJson;
      updateData.versions = {
        create: {
          content: contentJson,
          user: { connect: { id: userId } },
        },
      };

      console.log('Content after processing:', {
        documentId,
        content: updateData.content,
        timestamp: new Date().toISOString()
      });
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
        code: 'INVALID_REQUEST_DATA',
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
      // Check if document exists but user doesn't have access
      const documentExists = await db.document.findUnique({
        where: { id: documentId },
        select: { id: true }
      });

      if (documentExists) {
        return res.status(403).json({
          error: 'Access denied',
          code: 'ACCESS_DENIED',
          message: 'You do not have permission to delete this document'
        });
      }

      return res.status(404).json({
        error: 'Document not found',
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The requested document does not exist'
      });
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
        return res.status(404).json({
          error: 'Document not found',
          code: 'DOCUMENT_NOT_FOUND',
          message: 'The requested document does not exist'
        });
      }
      if (error.code === 'P2003') {
        return res.status(400).json({
          error: 'Document in use',
          code: 'DOCUMENT_IN_USE',
          message: 'Cannot delete document due to existing references'
        });
      }
    }

    return res.status(500).json({ error: 'Failed to delete document' });
  }
} 