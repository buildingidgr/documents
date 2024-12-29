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
      allowedHeaders: ["Authorization", "Content-Type", "Accept"],
      credentials: true
    },
    // Only allow WebSocket transport
    transports: ['websocket'],
    // Connection settings
    pingInterval: 30000,
    pingTimeout: 25000,
    connectTimeout: 60000,
    maxHttpBufferSize: 1e8,
    // Allow upgrades for Socket.IO handshake
    allowUpgrades: true,
    upgradeTimeout: 30000,
    // Enable compression for better performance
    perMessageDeflate: {
      threshold: 1024,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    },
    // Other options
    allowEIO3: true,
    cookie: false
  });

  // Add global authentication middleware
  io.use(async (socket: Socket, next) => {
    console.log('Global authentication attempt:', {
      socketId: socket.id,
      auth: socket.handshake.auth,
      headers: socket.handshake.headers,
      timestamp: new Date().toISOString()
    });

    try {
      // Get token from auth object
      const token = socket.handshake.auth?.token;
      
      if (!token) {
        console.log('No token in auth object:', {
          socketId: socket.id,
          auth: socket.handshake.auth,
          timestamp: new Date().toISOString()
        });
        return next(new Error('Authentication required'));
      }

      const userId = await authenticateUser(token);
      if (!userId) {
        console.log('Invalid token:', {
          socketId: socket.id,
          tokenLength: token.length,
          timestamp: new Date().toISOString()
        });
        return next(new Error('Invalid token'));
      }

      // Store user data and mark as authenticated
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
        socketId: socket.id,
        userId,
        timestamp: new Date().toISOString()
      });

      next();
    } catch (error) {
      console.error('Authentication error:', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication failed'));
    }
  });

  // Add connection monitoring
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', {
      socketId: socket.id,
      userId: socket.data.userId,
      auth: socket.handshake.auth,
      timestamp: new Date().toISOString()
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

    // Rest of the document namespace code remains the same...
  });

  return io;
}