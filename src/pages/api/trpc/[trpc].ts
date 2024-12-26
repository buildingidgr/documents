import { createNextApiHandler } from '@trpc/server/adapters/next';
import { appRouter } from '../../../server/api/root';
import { createTRPCContext } from '../../../server/api/trpc';
import type { NextApiRequest, NextApiResponse } from 'next'

const handler = createNextApiHandler({
  router: appRouter,
  createContext: createTRPCContext,
  onError:
    process.env.NODE_ENV === 'development'
      ? ({ path, error }) => {
          console.error(`❌ tRPC failed on ${path ?? '<no-path>'}: ${error.message}`);
        }
      : undefined,
});

export default async function (req: NextApiRequest, res: NextApiResponse) {
  console.log('Raw request:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
  });

  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (error) {
      console.error('Failed to parse request body:', error);
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
  }

  console.log('Parsed request body:', req.body);

  // Check if the body is already in the correct format
  if (!req.body['0'] || !req.body['0'].json) {
    // If not, wrap the entire body as input for tRPC
    const wrappedBody = {
      0: {
        json: req.body
      }
    };
    req.body = wrappedBody;
  }

  console.log('Final request body:', req.body);

  return handler(req, res);
}

