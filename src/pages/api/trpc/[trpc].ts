import { createNextApiHandler } from '@trpc/server/adapters/next';
import { appRouter } from '../../../server/api/root';
import { createTRPCContext } from '../../../server/api/trpc';

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

export default async function (req, res) {
  // Log the raw request
  console.log('Raw request:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
  });

  // If the body is a string, try to parse it as JSON
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (error) {
      console.error('Failed to parse request body:', error);
      return res.status(400).json({ error: 'Invalid JSON in request body' });
    }
  }

  // Log the parsed request body
  console.log('Parsed request body:', req.body);

  // If the body doesn't contain an input property, wrap the entire body as input
  if (req.body && !req.body.input && req.body.title && req.body.content) {
    req.body = { input: req.body };
  }

  // Log the final request body
  console.log('Final request body:', req.body);

  return handler(req, res);
}

