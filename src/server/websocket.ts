import { Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
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
  pingTimeout?: number;
  writable?: boolean;
  destroyed?: boolean;
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

  // Create Socket.IO server
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>({
    path: '/ws',
    cors: {
      origin: async (origin, callback) => {
        // Always allow localhost for development
        if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
          callback(null, true);
          return;
        }

        try {
          // Here you would typically:
          // 1. Extract customer/tenant ID from the request (e.g., from subdomain or auth token)
          // 2. Look up allowed domains for that customer in your database
          // 3. Validate the origin against the allowed domains
          
          // For now, we'll allow all origins in production
          // TODO: Implement proper domain validation based on customer/tenant
          callback(null, true);
        } catch (error) {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Accept"],
      credentials: true
    },
    // Connection settings
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 10000,
    maxHttpBufferSize: 1e8,
    // Socket.IO options
    allowUpgrades: false,
    upgradeTimeout: 10000,
    // Enable compression
    perMessageDeflate: {
      threshold: 1024,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    },
    // Other options
    allowEIO3: true,
    cookie: false,
    serveClient: false
  });

  // Attach to server after configuration
  io.attach(server);

  // Add authentication middleware
  io.use(async (socket, next) => {
    try {
      console.log('Socket connection attempt:', {
        id: socket.id,
        handshake: socket.handshake,
        timestamp: new Date().toISOString()
      });

      const token = socket.handshake.auth?.token;
      if (!token) {
        console.log('No auth token in handshake:', {
          id: socket.id,
          handshake: socket.handshake,
          timestamp: new Date().toISOString()
        });
        return next(new Error('Authentication required'));
      }

      console.log('Authenticating with token:', {
        id: socket.id,
        token,
        timestamp: new Date().toISOString()
      });

      const userId = await authenticateUser(token);
      if (!userId) {
        console.log('Invalid token:', {
          id: socket.id,
          timestamp: new Date().toISOString()
        });
        return next(new Error('Invalid token'));
      }

      // Store connection info
      socket.data.userId = userId;
      connections.set(socket.id, {
        userId,
        connectedAt: new Date(),
        transport: socket.conn.transport.name,
        namespaces: new Set(['/document']),
        engineId: socket.id,
        authenticated: true
      });

      console.log('Authentication successful:', {
        id: socket.id,
        userId,
        timestamp: new Date().toISOString()
      });

      next();
    } catch (error) {
      console.error('Authentication error:', {
        id: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication failed'));
    }
  });

  // Monitor all connections
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', {
      socketId: socket.id,
      userId: socket.data.userId,
      timestamp: new Date().toISOString()
    });

    // Monitor connection state
    socket.conn.on('packet', (packet: any) => {
      const conn = connections.get(socket.id);
      if (conn) {
        conn.lastPing = new Date();
      }
      
      if (packet.type === 'ping' || packet.type === 'pong') {
        console.log('Heartbeat:', {
          socketId: socket.id,
          type: packet.type,
          timestamp: new Date().toISOString()
        });
      }
    });

    socket.on('disconnect', (reason) => {
      const conn = connections.get(socket.id);
      connections.delete(socket.id);
      
      console.log('Client disconnected:', {
        socketId: socket.id,
        userId: socket.data.userId,
        reason,
        wasAuthenticated: !!socket.data.userId,
        duration: conn ? Date.now() - conn.connectedAt.getTime() : 0,
        lastPing: conn?.lastPing,
        timestamp: new Date().toISOString()
      });
    });

    // Monitor errors
    socket.on('error', (error: Error) => {
      console.error('Socket error:', {
        socketId: socket.id,
        userId: socket.data.userId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    });
  });

  // Create document namespace
  const docNamespace = io.of('/document');

  // Document namespace connection handling
  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Client connected to document namespace:', {
      socketId: socket.id,
      userId: socket.data.userId,
      timestamp: new Date().toISOString()
    });

    // Handle document events
    socket.on('document:join', async (documentId: string) => {
      try {
        // Store document ID
        socket.data.documentId = documentId;
        const conn = connections.get(socket.id);
        if (conn) {
          conn.documentId = documentId;
        }

        // Join the document room
        await socket.join(documentId);

        // Notify others
        socket.to(documentId).emit('document:joined', {
          documentId,
          userId: socket.data.userId!
        });

        console.log('Client joined document:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error joining document:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
        socket.emit('error', { message: 'Failed to join document' });
      }
    });

    socket.on('document:update', async (data: DocumentUpdate) => {
      try {
        // Broadcast the update to others in the document
        socket.to(data.documentId).emit('document:update', data);

        console.log('Document update:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId: data.documentId,
          type: data.type,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error updating document:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId: data.documentId,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
        socket.emit('error', { message: 'Failed to update document' });
      }
    });
  });

  return io;
}