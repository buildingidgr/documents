import { createServer, IncomingMessage } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { Socket } from 'net';
import next from 'next';
import { setupWebSocket } from './websocket';
import { db } from './db';
import { authenticateUser } from './auth';

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ 
  dev,
  dir: __dirname + '/../..' // Point to the root directory where pages/ is located
});
const handle = nextApp.getRequestHandler();

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

async function main() {
  try {
    await nextApp.prepare();
    console.log('Next.js initialization complete');

    const app = express();
    const server = createServer(app);

    // Add body parsing middleware
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Add logging middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip logging for WebSocket requests
      if (req.headers.upgrade === 'websocket') {
        return next();
      }
      console.log('Incoming request:', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query
      });
      next();
    });

    // Add CORS middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip CORS for WebSocket upgrade requests
      if (req.headers.upgrade === 'websocket') {
        return next();
      }

      // Handle CORS for HTTP requests
      const origin = req.headers.origin || '*';
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }
      next();
    });

    // Add authentication middleware
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      // Skip auth middleware for WebSocket requests
      if (req.headers.upgrade === 'websocket') {
        return next();
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

    // Initialize Socket.IO once
    const io = setupWebSocket(server);

    // Add health check endpoint
    app.get('/api/healthcheck', (req: Request, res: Response) => {
      res.status(200).json({ status: 'ok' });
    });

    // Let Next.js handle all routes except WebSocket
    app.all('*', (req: Request, res: Response) => {
      // Let Socket.IO handle WebSocket upgrade requests
      if (req.headers.upgrade === 'websocket') {
        return;
      }
      // Let Next.js handle all other paths
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