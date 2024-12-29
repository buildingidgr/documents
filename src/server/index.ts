import { createServer } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import next from 'next';
import { setupWebSocket } from './websocket';
import { db } from './db';
import { authenticateUser } from './auth';
import { IncomingMessage } from 'http';
import { Socket } from 'net';

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

    // Trust proxy
    app.set('trust proxy', true);

    // Add CORS middleware first
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Get the real origin from X-Forwarded-Host or Origin
      const origin = req.headers['x-forwarded-host'] || 
                    req.headers.origin || 
                    req.headers.host || 
                    '*';
      
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

    // Add body parsing middleware
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Add logging middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Log all requests including WebSocket upgrade requests
      console.log('Incoming request:', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query,
        ip: req.ip,
        protocol: req.protocol,
        secure: req.secure,
        xhr: req.xhr,
        originalUrl: req.originalUrl
      });
      next();
    });

    // Add authentication middleware
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      // Skip auth for WebSocket requests - they'll be handled by Socket.IO auth
      if (req.url?.startsWith('/ws')) {
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

    // Initialize Socket.IO after all middleware
    const io = setupWebSocket(server);

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