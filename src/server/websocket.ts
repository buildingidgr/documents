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
    // Connection settings
    transports: ['websocket'],
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 10000,
    maxHttpBufferSize: 1e8,
    // Socket.IO options
    allowUpgrades: true,
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
    serveClient: false,
    // Prevent HTTP server interference
    httpCompression: false
  });

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

    // Rest of the document namespace code remains the same...
  });

  return io;
}