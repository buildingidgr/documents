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

  // Wrap the entire body as input for tRPC
  const wrappedBody = {
    0: {
      json: {
        input: req.body
      }
    }
  };

  console.log('Wrapped request body:', wrappedBody);

  // Replace the original request body with the wrapped version
  req.body = wrappedBody;

  return handler(req, res);
}

