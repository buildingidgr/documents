import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '../../../server/db';
import { authenticateUser } from '../../../server/auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

const documentInputSchema = z.object({
  title: z.string(),
  content: z.any(),
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

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body) as DocumentInput;

    // Create document
    const newDocument = await prisma.document.create({
      data: {
        title: validatedInput.title,
        content: validatedInput.content as Prisma.InputJsonValue,
        users: {
          connect: { id: userId },
        },
        versions: {
          create: {
            content: validatedInput.content as Prisma.InputJsonValue,
            user: { connect: { id: userId } },
          },
        },
      },
    });

    return res.status(200).json(newDocument);
  } catch (err: unknown) {
    console.error('Error creating document:', err);
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors });
    }
    
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const error = err as Prisma.PrismaClientKnownRequestError;
      return res.status(500).json({ error: `Database error: ${error.message}` });
    }
    
    const error = err instanceof Error ? err.message : 'Internal server error';
    return res.status(500).json({ error });
  }
} 