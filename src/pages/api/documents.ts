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
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);

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

  } catch (err: unknown) {
    console.error('Error fetching documents:', {
      error: err instanceof Error ? err.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });

    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Invalid query parameters',
        details: err.errors
      });
    }

    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
} 