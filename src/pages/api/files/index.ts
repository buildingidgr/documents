import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';
import type { FileStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Client } from '@/lib/s3';

// Validate query parameters
const querySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 10),
  type: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  search: z.string().optional()
}).transform(data => ({
  ...data,
  page: data.page || 1,
  limit: data.limit || 10,
  status: data.status as FileStatus | undefined
}));

type QueryParams = z.infer<typeof querySchema>;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
      message: 'Only GET method is allowed for this endpoint'
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

    try {
      const userId = await authenticateUser(token);
      console.log('[Files List] User authenticated:', userId);

      try {
        // Validate and parse query parameters
        const { page, limit, type, status, search } = querySchema.parse(req.query);

        // Build where clause
        const where: Prisma.FileWhereInput = {
          userId,
          ...(type && { type }),
          ...(status && { status }),
          ...(search && {
            OR: [
              {
                name: {
                  contains: search,
                  mode: 'insensitive'
                }
              },
              {
                type: {
                  contains: search,
                  mode: 'insensitive'
                }
              }
            ]
          })
        };

        // Calculate pagination
        const skip = (page - 1) * limit;

        // Fetch files with pagination
        const [files, total] = await Promise.all([
          db.file.findMany({
            where,
            skip,
            take: limit,
            orderBy: { uploadedAt: 'desc' },
            select: {
              id: true,
              name: true,
              type: true,
              size: true,
              url: true,
              key: true,
              status: true,
              uploadedAt: true,
              updatedAt: true,
              metadata: true
            }
          }),
          db.file.count({ where })
        ]);

        // Generate presigned URLs for all files
        const s3Client = getS3Client();
        const bucketName = process.env.AWS_BUCKET_NAME;
        if (!bucketName) {
          throw new Error('AWS_BUCKET_NAME is not set');
        }

        const filesWithPresignedUrls = await Promise.all(
          files.map(async (file) => {
            try {
              const command = new GetObjectCommand({
                Bucket: bucketName,
                Key: file.key,
                ResponseContentDisposition: 'inline'
              });

              const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
              return {
                ...file,
                url: presignedUrl
              };
            } catch (error) {
              console.error('Error generating presigned URL for file:', {
                fileId: file.id,
                error: error instanceof Error ? error.message : 'Unknown error'
              });
              return file;
            }
          })
        );

        // Calculate pagination metadata
        const totalPages = Math.ceil(total / limit);
        const hasMore = page < totalPages;

        // Return paginated results with metadata
        return res.status(200).json({
          files: filesWithPresignedUrls,
          pagination: {
            total,
            page,
            totalPages,
            hasMore
          }
        });
      } catch (queryError) {
        if (queryError instanceof z.ZodError) {
          return res.status(400).json({ 
            error: 'Invalid query parameters',
            code: 'INVALID_PARAMETERS',
            message: 'The provided query parameters are invalid',
            details: queryError.errors
          });
        }
        throw queryError;
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
    console.error('[Files List] Unhandled error:', {
      error: err instanceof Error ? {
        message: err.message,
        name: err.name,
        stack: err.stack
      } : 'Unknown error',
      timestamp: new Date().toISOString()
    });

    return res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    });
  }
} 