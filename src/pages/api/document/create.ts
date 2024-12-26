import { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '../../../server/db';
import { authenticateUser } from '../../../server/auth';
import { z } from 'zod';

const documentInputSchema = z.object({
  title: z.string(),
  content: z.any(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Authenticate user
    const token = req.headers.authorization?.split(' ')[1];
    const userId = await authenticateUser(token);

    // Validate input
    const validatedInput = documentInputSchema.parse(req.body);

    // Create document
    const newDocument = await prisma.document.create({
      data: {
        title: validatedInput.title,
        content: validatedInput.content,
        users: {
          connect: { id: userId },
        },
        versions: {
          create: {
            content: validatedInput.content,
            user: { connect: { id: userId } },
          },
        },
      },
    });

    return res.status(200).json(newDocument);
  } catch (error) {
    console.error('Error creating document:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
} 