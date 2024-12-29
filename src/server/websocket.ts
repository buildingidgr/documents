import { Server as HttpServer, IncomingMessage } from 'http';
import { Server, Socket } from 'socket.io';
import { instrument } from '@socket.io/admin-ui';
import { authenticateUser } from './auth';
import { db } from './db';
import { Prisma } from '@prisma/client';

// Add Socket.IO engine types
interface EngineSocket {
  id: string;
  transport?: {
    name: string;
  };
  request?: {
    headers: Record<string, string | string[] | undefined>;
  };
}

// Add Socket.IO error types
interface SocketError {
  code: string;
  message: string;
  type: string;
  req?: {
    url?: string;
  };
}

interface ServerToClientEvents {
  'error': (data: { message: string }) => void;
  'document:joined': (data: { documentId: string; userId: string }) => void;
  'document:update': (data: DocumentUpdate) => void;
  'document:presence': (data: { type: string; userId: string; documentId: string; data: any }) => void;
}

interface ClientToServerEvents {
  'document:join': (documentId: string) => void;
  'document:update': (data: DocumentUpdate) => void;
  'disconnect': () => void;
}

interface InterServerEvents {
  ping: () => void;
}

interface SocketData {
  userId?: string;
  documentId?: string;
}

type DocumentSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

interface DocumentUpdate {
  type: string;
  documentId: string;
  userId: string;
  content: any;
  data?: any;
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up Socket.IO server...');

  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
    path: '/ws',
    cors: {
      origin: [
        'http://localhost:3000',
        'https://localhost:3000',
        'https://documents-production.up.railway.app',
        'https://piehost.com',
        'http://piehost.com',
        'https://websocketking.com',
        'https://www.websocketking.com',
        'https://postman.com',
        'https://www.postman.com',
        'https://admin.socket.io',
        'chrome-extension://ophmdkgfcjapomjdpfobjfbihojchbko'
      ],
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e8,
    allowUpgrades: true,
    upgradeTimeout: 10000,
    allowEIO3: true
  });

  // Enable Socket.IO debug mode via environment variable
  if (process.env.DEBUG) {
    console.log('Socket.IO debug mode enabled');
  }

  // Add connection monitoring
  io.engine.on('connection', (socket: EngineSocket) => {
    console.log('New engine connection:', {
      id: socket.id,
      transport: socket.transport?.name,
      headers: socket.request?.headers,
      timestamp: new Date().toISOString()
    });
  });

  // Add detailed error monitoring
  io.engine.on('connection_error', (err: SocketError) => {
    console.error('Engine connection error:', {
      code: err.code,
      message: err.message,
      type: err.type,
      req: err.req?.url,
      timestamp: new Date().toISOString()
    });
  });

  io.engine.on('headers', (headers: Record<string, string>, req: IncomingMessage) => {
    console.log('Engine headers:', {
      headers,
      url: req.url,
      method: req.method,
      timestamp: new Date().toISOString()
    });
  });

  const docNamespace = io.of('/document');

  // Authentication middleware
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    try {
      const token = socket.handshake.auth.token || 
                    socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        console.log('Authentication failed: No token provided');
        return next(new Error('Authentication required'));
      }

      try {
        const userId = await authenticateUser(token);
        if (!userId) {
          console.log('Authentication failed: Invalid token');
          return next(new Error('Invalid token'));
        }

        socket.data.userId = userId;
        
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name
        });
        
        next();
      } catch (error) {
        console.error('Socket auth error:', error);
        next(new Error('Authentication failed'));
      }
    } catch (error) {
      console.error('Socket middleware error:', error);
      next(new Error('Authentication failed'));
    }
  });

  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Client connected:', {
      userId: socket.data.userId,
      socketId: socket.id,
      transport: socket.conn?.transport?.name
    });

    socket.on('document:join', async (documentId: string) => {
      try {
        if (!socket.data.userId) {
          socket.emit('error', { message: 'Not authenticated' });
          return;
        }

        // Verify document access
        const document = await db.document.findFirst({
          where: {
            id: documentId,
            users: {
              some: {
                id: socket.data.userId
              }
            }
          }
        });

        if (!document) {
          socket.emit('error', { message: 'Document access denied' });
          return;
        }

        // Leave previous document room if any
        if (socket.data.documentId) {
          socket.leave(socket.data.documentId);
        }

        // Join document room
        socket.join(documentId);
        socket.data.documentId = documentId;

        socket.emit('document:joined', {
          documentId,
          userId: socket.data.userId
        });

        // Notify other clients in the room
        socket.to(documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.data.userId,
          documentId: documentId,
          data: { status: 'online' }
        });
      } catch (error) {
        console.error('Error joining document:', error);
        socket.emit('error', { message: 'Failed to join document' });
      }
    });

    // Handle document updates
    socket.on('document:update', async (data: DocumentUpdate) => {
      if (!socket.data.userId || !socket.data.documentId) {
        socket.emit('error', { message: 'Not authenticated or not in a document' });
        return;
      }

      try {
        // Update document in database
        await db.document.update({
          where: { id: socket.data.documentId },
          data: {
            content: data.content as Prisma.InputJsonValue,
            versions: {
              create: {
                content: data.content as Prisma.InputJsonValue,
                user: { connect: { id: socket.data.userId } }
              }
            }
          }
        });

        // Broadcast update to other clients
        socket.to(socket.data.documentId).emit('document:update', {
          type: 'update',
          userId: socket.data.userId,
          documentId: socket.data.documentId,
          content: data.content
        });
      } catch (error) {
        console.error('Document update error:', error);
        socket.emit('error', { message: 'Failed to update document' });
      }
    });

    // Handle disconnection
    socket.on('disconnect', (reason: string) => {
      console.log('Client disconnected:', {
        reason,
        userId: socket.data.userId,
        socketId: socket.id,
        transport: socket.conn?.transport?.name
      });

      if (socket.data.documentId && socket.data.userId) {
        socket.to(socket.data.documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.data.userId,
          documentId: socket.data.documentId,
          data: { status: 'offline' }
        });
      }
    });
  });

  // Initialize Socket.IO Admin UI
  instrument(io, {
    auth: false,
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  });

  return io;
}