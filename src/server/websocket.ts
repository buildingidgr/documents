import { Server as HttpServer, IncomingMessage } from 'http';
import { Server, Socket } from 'socket.io';
import { instrument } from '@socket.io/admin-ui';
import { authenticateUser } from './auth';
import { db } from './db';
import { Prisma } from '@prisma/client';

// Add Socket.IO request types
interface AllowRequestCallback {
  (err: string | null | undefined, success: boolean): void;
}

// Add Socket.IO engine types
interface EngineSocket {
  id: string;
  transport?: {
    name: string;
    sid?: string;
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

// Add Socket.IO transport types
interface Transport {
  name: string;
  sid: string;
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

type DocumentSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
> & {
  conn: {
    transport: Transport;
  };
};

interface DocumentUpdate {
  type: string;
  documentId: string;
  userId: string;
  content: any;
  data?: any;
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up Socket.IO server...');

  // Track active connections and their states
  const connections = new Map<string, {
    userId?: string;
    documentId?: string;
    connectedAt: Date;
    lastPing?: Date;
    transport: string;
    namespaces: Set<string>;
    engineId?: string;
    authenticated: boolean;
  }>();

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
      methods: ["GET", "POST"],
      allowedHeaders: ["Authorization"],
      credentials: true
    },
    transports: ['websocket'],  // WebSocket only, no polling
    pingInterval: 15000,
    pingTimeout: 10000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e8,
    allowUpgrades: false,      // No transport upgrades needed
    upgradeTimeout: 10000,
    perMessageDeflate: {
      threshold: 2048,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    }
  });

  // Create document namespace with authentication requirement
  const docNamespace = io.of('/document');

  // Authentication middleware with timeout
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    const authTimeout = setTimeout(() => {
      console.error('Authentication timeout:', {
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication timeout'));
    }, 5000);

    try {
      // Get token from auth header only (consistent with HTTP API)
      const token = socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        clearTimeout(authTimeout);
        console.log('Authentication failed: No token provided', {
          socketId: socket.id
        });
        return next(new Error('Authentication required'));
      }

      try {
        const userId = await authenticateUser(token);
        clearTimeout(authTimeout);
        
        if (!userId) {
          console.log('Authentication failed: Invalid token', {
            socketId: socket.id
          });
          return next(new Error('Invalid token'));
        }

        // Store user info and track connection
        socket.data.userId = userId;
        connections.set(socket.id, {
          userId,
          connectedAt: new Date(),
          transport: socket.conn.transport.name,
          namespaces: new Set(['/document']),
          engineId: socket.conn.transport.sid,
          authenticated: true
        });
        
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn.transport.name
        });
        
        next();
      } catch (error) {
        clearTimeout(authTimeout);
        console.error('Socket auth error:', error);
        next(new Error('Authentication failed'));
      }
    } catch (error) {
      clearTimeout(authTimeout);
      console.error('Socket middleware error:', error);
      next(new Error('Authentication failed'));
    }
  });

  // Handle document collaboration events
  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Client connected to document namespace:', {
      socketId: socket.id,
      userId: socket.data.userId,
      timestamp: new Date().toISOString()
    });

    // Handle document join
    socket.on('document:join', async (documentId: string) => {
      try {
        if (!socket.data.userId) {
          socket.emit('error', { message: 'Not authenticated' });
          return;
        }

        // Verify document access through HTTP API service
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

        // Update connection tracking
        const conn = connections.get(socket.id);
        if (conn) {
          conn.documentId = documentId;
          connections.set(socket.id, conn);
        }

        // Notify client of successful join
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

    // Handle real-time document updates
    socket.on('document:update', (data: DocumentUpdate) => {
      if (!socket.data.userId || !socket.data.documentId) {
        socket.emit('error', { message: 'Not authenticated or not in a document' });
        return;
      }

      // Broadcast update to other clients in the room
      socket.to(socket.data.documentId).emit('document:update', {
        type: 'update',
        userId: socket.data.userId,
        documentId: socket.data.documentId,
        content: data.content
      });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      const conn = connections.get(socket.id);
      connections.delete(socket.id);
      
      console.log('Client disconnected:', {
        socketId: socket.id,
        userId: socket.data.userId,
        documentId: socket.data.documentId,
        duration: conn ? Date.now() - conn.connectedAt.getTime() : 0,
        timestamp: new Date().toISOString()
      });

      // Notify other clients if the user was in a document
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

  return io;
}