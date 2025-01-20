import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import type { FileStatus } from '@prisma/client';
import { getS3Client } from '@/lib/s3';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

// Define metadata schema
const fileMetadataSchema = z.object({
  fileType: z.string(),
  description: z.string(),
  version: z.number()
});

type FileMetadata = z.infer<typeof fileMetadataSchema>;

// Validation schemas
const updateFileSchema = z.object({
  name: z.string().optional(),
  metadata: z.object({
    fileType: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
}).transform(data => ({
  ...data,
  status: data.status as FileStatus | undefined
}));

type UpdateFileInput = z.infer<typeof updateFileSchema>;

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

    // Parse and validate existing metadata
    let currentMetadata: FileMetadata;
    try {
      currentMetadata = fileMetadataSchema.parse(file.metadata);
    } catch (error) {
      // If metadata is invalid, set default values
      currentMetadata = {
        fileType: file.type,
        description: '',
        version: 1
      };
    }

    // Update file
    const updatedFile = await db.file.update({
      where: { id: fileId },
      data: {
        ...(validatedInput.name && { name: validatedInput.name }),
        ...(validatedInput.status && { status: validatedInput.status }),
        ...(validatedInput.metadata && {
          metadata: {
            fileType: validatedInput.metadata.fileType ?? currentMetadata.fileType,
            description: validatedInput.metadata.description ?? currentMetadata.description,
            version: currentMetadata.version
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

    // Delete file from S3
    try {
      const s3Client = getS3Client();
      const bucketName = process.env.AWS_BUCKET_NAME;
      if (!bucketName) {
        throw new Error('AWS_BUCKET_NAME is not set');
      }

      await s3Client.send(new DeleteObjectCommand({
        Bucket: bucketName,
        Key: file.key
      }));

      console.log('Successfully deleted file from S3:', {
        bucket: bucketName,
        key: file.key,
        fileId: file.id,
        timestamp: new Date().toISOString()
      });
    } catch (s3Error) {
      console.error('Error deleting file from S3:', {
        error: s3Error instanceof Error ? s3Error.message : 'Unknown error',
        fileId: file.id,
        key: file.key,
        timestamp: new Date().toISOString()
      });
      return res.status(500).json({
        error: 'Failed to delete file from storage',
        code: 'S3_DELETE_FAILED',
        message: 'Failed to delete file from storage service'
      });
    }

    // Delete file from database
    try {
      await db.file.delete({
        where: { id: fileId }
      });

      console.log('Successfully deleted file record:', {
        fileId: file.id,
        timestamp: new Date().toISOString()
      });

      return res.status(204).end();
    } catch (dbError) {
      console.error('Error deleting file from database:', {
        error: dbError instanceof Error ? dbError.message : 'Unknown error',
        fileId: file.id,
        timestamp: new Date().toISOString()
      });
      return res.status(500).json({
        error: 'Failed to delete file record',
        code: 'DB_DELETE_FAILED',
        message: 'Failed to delete file record from database'
      });
    }
  } catch (error) {
    console.error('Error handling delete request:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      fileId,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while deleting the file'
    });
  }
} 