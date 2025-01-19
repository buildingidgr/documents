import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';

// Validate query parameters
const querySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 10),
  type: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional()
});

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
        const where = {
          userId,
          ...(type && { type }),
          ...(status && { status }),
          ...(search && {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { type: { contains: search, mode: 'insensitive' } }
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
              status: true,
              uploadedAt: true,
              updatedAt: true,
              metadata: true
            }
          }),
          db.file.count({ where })
        ]);

        // Calculate pagination metadata
        const totalPages = Math.ceil(total / limit);
        const hasMore = page < totalPages;

        // Return paginated results with metadata
        return res.status(200).json({
          files,
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