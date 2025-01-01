import type { NextApiRequest, NextApiResponse } from 'next';
import { db } from '@/server/db';
import { authenticateUser } from '@/server/auth';
import { z } from 'zod';

// Validate query parameters
const querySchema = z.object({
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 10),
  cursor: z.string().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt', 'title']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc')
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
      console.log('[Documents List] User authenticated:', userId);

      try {
        // Validate and parse query parameters
        const { limit, cursor, orderBy, order } = querySchema.parse(req.query);

        // Fetch one extra item to determine if there are more items
        const documents = await db.document.findMany({
          where: {
            users: {
              some: {
                id: userId,
              },
            },
          },
          take: limit + 1,
          ...(cursor
            ? {
                skip: 1, // Skip the cursor
                cursor: {
                  id: cursor,
                },
              }
            : {}),
          orderBy: {
            [orderBy]: order,
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
                createdAt: true,
              },
            },
          },
        });

        // Check if there are more items
        const hasMore = documents.length > limit;
        const items = hasMore ? documents.slice(0, -1) : documents;

        // Get total count for pagination info
        const totalCount = await db.document.count({
          where: {
            users: {
              some: {
                id: userId,
              },
            },
          },
        });

        // Construct pagination metadata
        const nextCursor = hasMore ? items[items.length - 1].id : null;
        const paginationInfo = {
          totalCount,
          pageSize: limit,
          hasMore,
          nextCursor,
        };

        // Return paginated results with metadata
        return res.status(200).json({
          items,
          pagination: paginationInfo,
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
    console.error('[Documents List] Unhandled error:', {
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