import { createServer, IncomingMessage } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { Socket } from 'net';
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    const userId = await authenticateUser(token);
    if (userId) {
      req.user = { id: userId };
    }
    next();
  } catch (error) {
    console.error('Auth error:', error);
    next();
  }
});

// Add API routes
app.post('/api/document/create', async (req: Request, res: Response) => {
  try {
    // Get authorization token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      res.status(401).json({ error: 'No authorization token provided' });
      return;
    }

    // Verify user is authenticated
    if (!req.user?.id) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    // Get request body
    const { title, content } = req.body;
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    // Create document
    const document = await db.document.create({
      data: {
        title,
        content: content || {},
        users: {
          connect: {
            id: req.user.id
          }
        }
      }
    });

    res.status(201).json(document);
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// Add health check endpoint
app.get('/api/healthcheck', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// Handle WebSocket upgrade requests
server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
  const upgradeHeader = request.headers['upgrade'];
  if (upgradeHeader !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  console.log('WebSocket upgrade request received');
});

// Initialize Socket.IO
const io = setupWebSocket(server);

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

export default app; 