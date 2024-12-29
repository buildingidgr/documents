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
    // Connection settings
    transports: ['websocket'],
    pingInterval: 10000,
    pingTimeout: 5000,
    connectTimeout: 10000,
    maxHttpBufferSize: 1e8,
    // Allow upgrades for Socket.IO handshake
    allowUpgrades: true,
    upgradeTimeout: 5000,
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

  // Track engine-level events
  io.engine.on('initial_headers', (headers: any, req: any) => {
    console.log('Initial headers:', {
      url: req.url,
      method: req.method,
      headers: req.headers,
      timestamp: new Date().toISOString()
    });
  });

  io.engine.on('headers', (headers: any, req: any) => {
    console.log('Headers event:', {
      url: req.url,
      method: req.method,
      headers: req.headers,
      timestamp: new Date().toISOString()
    });
  });

  // Add global authentication middleware with timeout
  io.use((socket: Socket, next) => {
    const authTimeout = setTimeout(() => {
      console.log('Auth timeout reached:', {
        socketId: socket.id,
        handshake: socket.handshake,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication timeout'));
    }, 5000);

    // Log connection attempt
    console.log('Connection attempt:', {
      socketId: socket.id,
      handshake: socket.handshake,
      timestamp: new Date().toISOString()
    });

    // Check for auth data
    if (!socket.handshake.auth?.token) {
      clearTimeout(authTimeout);
      console.log('No auth token provided:', {
        socketId: socket.id,
        handshake: socket.handshake,
        timestamp: new Date().toISOString()
      });
      return next(new Error('Authentication required'));
    }

    // Proceed with authentication
    authenticateUser(socket.handshake.auth.token)
      .then(userId => {
        clearTimeout(authTimeout);
        if (!userId) {
          console.log('Invalid token:', {
            socketId: socket.id,
            handshake: socket.handshake,
            timestamp: new Date().toISOString()
          });
          return next(new Error('Invalid token'));
        }

        // Store user data
        socket.data.userId = userId;
        connections.set(socket.id, {
          userId,
          connectedAt: new Date(),
          transport: socket.conn.transport.name,
          namespaces: new Set(['/document']),
          engineId: socket.conn.transport.sid,
          authenticated: true
        });

        console.log('Authentication successful:', {
          socketId: socket.id,
          userId,
          timestamp: new Date().toISOString()
        });

        next();
      })
      .catch(error => {
        clearTimeout(authTimeout);
        console.error('Authentication error:', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          handshake: socket.handshake,
          timestamp: new Date().toISOString()
        });
        next(new Error('Authentication failed'));
      });
  });

  // Monitor all connections
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', {
      socketId: socket.id,
      userId: socket.data.userId,
      auth: socket.handshake.auth,
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