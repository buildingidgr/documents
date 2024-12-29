import { createServer } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import next from 'next';
import { setupWebSocket } from './websocket';
import { db } from './db';
import { authenticateUser } from './auth';

// Add type for the extended Request
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
      };
    }
  }
}

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ 
  dev,
  dir: __dirname + '/../..' // Point to the root directory where pages/ is located
});
const handle = nextApp.getRequestHandler();

async function main() {
  try {
    await nextApp.prepare();
    console.log('Next.js initialization complete');

    const app = express();
    const server = createServer(app);

    // Initialize Socket.IO before any middleware
    const io = setupWebSocket(server);

    // Skip middleware for WebSocket requests
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isWebSocketRequest = (
        req.headers.upgrade === 'websocket' ||
        req.headers['sec-websocket-key'] ||
        req.url.startsWith('/ws')
      );

      if (isWebSocketRequest) {
        next();
        return;
      }

      // Add CORS middleware for HTTP requests only
      const origin = req.headers.origin || '*';
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }

      // Add body parsing middleware for HTTP requests only
      express.json()(req, res, (err: Error | null) => {
        if (err) {
          console.error('Body parsing error:', err);
          next(err);
          return;
        }
        express.urlencoded({ extended: true })(req, res, next);
      });
    });

    // Add logging middleware for HTTP requests only
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isWebSocketRequest = (
        req.headers.upgrade === 'websocket' ||
        req.headers['sec-websocket-key'] ||
        req.url.startsWith('/ws')
      );

      if (isWebSocketRequest) {
        next();
        return;
      }

      console.log('Incoming HTTP request:', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query
      });
      next();
    });

    // Add authentication middleware for HTTP requests only
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      const isWebSocketRequest = (
        req.headers.upgrade === 'websocket' ||
        req.headers['sec-websocket-key'] ||
        req.url.startsWith('/ws')
      );

      if (isWebSocketRequest) {
        next();
        return;
      }

      try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
          next();
          return;
        }

        console.log('Validating token:', token.substring(0, 20) + '...');
        const userId = await authenticateUser(token);
        console.log('Token validation response:', { isValid: !!userId, userId });
        
        if (userId) {
          req.user = { id: userId };
        }
        next();
      } catch (error) {
        console.error('Auth error:', error);
        next();
      }
    });

    // Add health check endpoint
    app.get('/api/healthcheck', (req: Request, res: Response) => {
      res.status(200).json({ status: 'ok' });
    });

    // Let Next.js handle all other routes
    app.all('*', (req: Request, res: Response) => {
      return handle(req, res);
    });

    // Add error handlers
    server.on('error', (err: Error) => {
      console.error('Server error:', err);
    });

    process.on('uncaughtException', (err: Error) => {
      console.error('Uncaught exception:', err);
    });

    process.on('unhandledRejection', (err: Error | null) => {
      console.error('Unhandled rejection:', err);
    });

    const port = process.env.PORT || 8080;
    server.listen(port, () => {
      console.log(`Server listening on port ${port}`);
      console.log(`WebSocket server ready at ws://localhost:${port}/ws`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main().catch(console.error);

export default nextApp; 