import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { UTApi } from "uploadthing/server";

const utapi = new UTApi();

// Validation schemas
const updateFileSchema = z.object({
  name: z.string().optional(),
  metadata: z.object({
    fileType: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

    try {
      const userId = await authenticateUser(token);
      const fileId = req.query.id as string;

      switch (req.method) {
        case 'GET':
          return handleGet(fileId, userId, res);
        case 'PATCH':
          return handleUpdate(fileId, userId, req.body, res);
        case 'DELETE':
          return handleDelete(fileId, userId, res);
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
  } catch (err) {
    console.error('Error handling file request:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(fileId: string, userId: string, res: NextApiResponse) {
  try {
    const file = await db.file.findFirst({
      where: {
        id: fileId,
        userId
      }
    });

    if (!file) {
      return res.status(404).json({
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
        message: 'The requested file does not exist'
      });
    }

    return res.status(200).json(file);
  } catch (error) {
    console.error('Error fetching file:', error);
    return res.status(500).json({ error: 'Failed to fetch file' });
  }
}

async function handleUpdate(
  fileId: string,
  userId: string,
  body: any,
  res: NextApiResponse
) {
  try {
    // Validate input
    const validatedInput = updateFileSchema.parse(body);

    // Check if file exists and belongs to user
    const file = await db.file.findFirst({
      where: {
        id: fileId,
        userId
      }
    });

    if (!file) {
      return res.status(404).json({
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
        message: 'The requested file does not exist'
      });
    }

    // Update file
    const updatedFile = await db.file.update({
      where: { id: fileId },
      data: {
        ...validatedInput,
        ...(validatedInput.metadata && {
          metadata: {
            ...file.metadata,
            ...validatedInput.metadata
          }
        })
      }
    });

    return res.status(200).json(updatedFile);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid request data',
        code: 'INVALID_REQUEST_DATA',
        details: error.errors
      });
    }

    console.error('Error updating file:', error);
    return res.status(500).json({ error: 'Failed to update file' });
  }
}

async function handleDelete(fileId: string, userId: string, res: NextApiResponse) {
  try {
    // Check if file exists and belongs to user
    const file = await db.file.findFirst({
      where: {
        id: fileId,
        userId
      }
    });

    if (!file) {
      return res.status(404).json({
        error: 'File not found',
        code: 'FILE_NOT_FOUND',
        message: 'The requested file does not exist'
      });
    }

    // Delete file from UploadThing
    await utapi.deleteFiles(file.key);

    // Delete file from database
    await db.file.delete({
      where: { id: fileId }
    });

    return res.status(204).end();
  } catch (error) {
    console.error('Error deleting file:', error);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
} 