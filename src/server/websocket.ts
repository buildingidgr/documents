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
    pingInterval: 15000,
    pingTimeout: 10000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e8,
    allowUpgrades: true,
    upgradeTimeout: 10000,
    allowEIO3: true,
    perMessageDeflate: {
      threshold: 2048,
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    },
    httpCompression: {
      threshold: 2048
    }
  });

  // Track active connections and their states
  const connections = new Map<string, {
    userId?: string;
    documentId?: string;
    connectedAt: Date;
    lastPing?: Date;
    transport: string;
  }>();

  // Add connection monitoring
  io.engine.on('connection', (socket: EngineSocket) => {
    const connInfo = {
      id: socket.id,
      transport: socket.transport?.name,
      headers: socket.request?.headers,
      timestamp: new Date().toISOString(),
      origin: socket.request?.headers.origin,
      forwardedFor: socket.request?.headers['x-forwarded-for'],
      forwardedProto: socket.request?.headers['x-forwarded-proto']
    };
    
    console.log('New engine connection:', connInfo);
    
    connections.set(socket.id, {
      connectedAt: new Date(),
      transport: socket.transport?.name || 'unknown'
    });

    // Log connection stats
    console.log('Active connections:', {
      total: connections.size,
      websocket: Array.from(connections.values()).filter(c => c.transport === 'websocket').length,
      polling: Array.from(connections.values()).filter(c => c.transport === 'polling').length,
      timestamp: new Date().toISOString()
    });
  });

  // Monitor ping/pong
  io.engine.on('packet', (packet: any, socket: EngineSocket) => {
    if (packet.type === 'ping') {
      const conn = connections.get(socket.id);
      if (conn) {
        conn.lastPing = new Date();
        connections.set(socket.id, conn);
      }
      console.log('Ping received:', {
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Add detailed error monitoring
  io.engine.on('connection_error', (err: SocketError) => {
    console.error('Engine connection error:', {
      code: err.code,
      message: err.message,
      type: err.type,
      req: err.req?.url,
      timestamp: new Date().toISOString(),
      activeConnections: connections.size
    });
  });

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
      const token = socket.handshake.auth.token || 
                    socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        clearTimeout(authTimeout);
        console.log('Authentication failed: No token provided');
        return next(new Error('Authentication required'));
      }

      try {
        const userId = await authenticateUser(token);
        clearTimeout(authTimeout);
        
        if (!userId) {
          console.log('Authentication failed: Invalid token');
          return next(new Error('Invalid token'));
        }

        socket.data.userId = userId;
        const conn = connections.get(socket.id);
        if (conn) {
          conn.userId = userId;
          connections.set(socket.id, conn);
        }
        
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name,
          activeConnections: connections.size
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

  // Handle disconnection and cleanup
  io.on('disconnect', (socket: Socket) => {
    const conn = connections.get(socket.id);
    connections.delete(socket.id);
    
    console.log('Connection closed:', {
      socketId: socket.id,
      userId: conn?.userId,
      duration: conn ? Date.now() - conn.connectedAt.getTime() : 0,
      remainingConnections: connections.size,
      timestamp: new Date().toISOString()
    });
  });

  // Log periodic connection stats
  setInterval(() => {
    const now = new Date();
    const stats = {
      total: connections.size,
      authenticated: Array.from(connections.values()).filter(c => c.userId).length,
      inDocument: Array.from(connections.values()).filter(c => c.documentId).length,
      byTransport: {
        websocket: Array.from(connections.values()).filter(c => c.transport === 'websocket').length,
        polling: Array.from(connections.values()).filter(c => c.transport === 'polling').length
      },
      timestamp: now.toISOString()
    };
    
    console.log('Connection stats:', stats);
    
    // Check for stale connections
    connections.forEach((conn, id) => {
      if (conn.lastPing && now.getTime() - conn.lastPing.getTime() > 30000) {
        console.warn('Stale connection detected:', {
          socketId: id,
          userId: conn.userId,
          lastPing: conn.lastPing.toISOString(),
          timestamp: now.toISOString()
        });
      }
    });
  }, 30000);

  return io;
}