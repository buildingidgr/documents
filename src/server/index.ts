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
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }
      next();
    });

    // Add authentication middleware
    app.use(async (req: Request, res: Response, next: NextFunction) => {
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

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const upgradeHeader = request.headers['upgrade'];
      const path = request.url;

      // Only handle WebSocket upgrades for /ws path
      if (upgradeHeader !== 'websocket' || !path?.startsWith('/ws')) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }

      console.log('WebSocket upgrade request received for path:', path);
    });

    // Initialize Socket.IO
    const io = setupWebSocket(server);

    // Add health check endpoint
    app.get('/api/healthcheck', (req: Request, res: Response) => {
      res.status(200).json({ status: 'ok' });
    });

    // Handle WebSocket routes first
    app.use('/ws', (req: Request, res: Response, next: NextFunction) => {
      console.log('WebSocket request received:', req.path);
      next();
    });

    // Let Next.js handle API routes
    app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      console.log('API request received:', req.path);
      return handle(req, res);
    });

    // Let Next.js handle all other routes
    app.all('*', (req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/ws')) {
        return handle(req, res);
      }
      next();
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