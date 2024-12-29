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
  on(event: string, listener: (...args: any[]) => void): void;
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

  // Track active connections and their states
  const connections = new Map<string, {
    userId?: string;
    documentId?: string;
    connectedAt: Date;
    lastPing?: Date;
    transport: string;
    namespaces: Set<string>;
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
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,        // More frequent ping
    pingTimeout: 5000,         // Shorter timeout
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

  // Add connection monitoring with enhanced error handling
  io.engine.on('connection', (socket: EngineSocket) => {
    try {
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
      
      // Initialize connection state
      connections.set(socket.id, {
        connectedAt: new Date(),
        transport: socket.transport?.name || 'unknown',
        namespaces: new Set(),
        authenticated: false,
        lastPing: new Date()  // Initialize last ping
      });

      // Log accurate connection stats
      const stats = getConnectionStats();
      console.log('Connection stats:', stats);

      // Set up ping handler for this socket
      socket.on('ping', () => {
        const conn = connections.get(socket.id);
        if (conn) {
          conn.lastPing = new Date();
          connections.set(socket.id, conn);
          console.log('Ping received:', {
            socketId: socket.id,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Handle socket errors
      socket.on('error', (error: Error) => {
        console.error('Socket error:', {
          socketId: socket.id,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
      });

    } catch (error) {
      console.error('Error in connection handler:', error);
    }
  });

  // Monitor all packet types for debugging
  io.engine.on('packet', (packet: any, socket: EngineSocket) => {
    console.log('Packet received:', {
      socketId: socket.id,
      type: packet.type,
      timestamp: new Date().toISOString()
    });

    if (packet.type === 'ping' || packet.type === 'pong') {
      const conn = connections.get(socket.id);
      if (conn) {
        conn.lastPing = new Date();
        connections.set(socket.id, conn);
      }
    }
  });

  // Clean up stale connections with more lenient timeout
  setInterval(() => {
    const now = Date.now();
    connections.forEach((conn, id) => {
      const lastActivity = conn.lastPing || conn.connectedAt;
      // More lenient timeout (2 minutes)
      if (now - lastActivity.getTime() > 120000) {
        console.log('Removing stale connection:', {
          socketId: id,
          userId: conn.userId,
          authenticated: conn.authenticated,
          lastPing: conn.lastPing?.toISOString(),
          connectedAt: conn.connectedAt.toISOString(),
          inactiveFor: Math.floor((now - lastActivity.getTime()) / 1000) + 's',
          timestamp: new Date().toISOString()
        });
        connections.delete(id);
      }
    });
    
    // Log detailed connection stats
    const stats = getConnectionStats();
    console.log('Connection stats after cleanup:', {
      ...stats,
      rawActiveConnections: io.engine.clientsCount,
      namespaceConnections: docNamespace.sockets.size,
      engineInfo: {
        clientsCount: io.engine.clientsCount,
        mainNamespaceConnections: io.sockets.size,
        documentNamespaceConnections: docNamespace.sockets.size,
        totalConnections: connections.size
      },
      timestamp: new Date().toISOString()
    });
  }, 60000); // Check every minute

  // Add connection event to track namespace connections
  io.on('connection', (socket: Socket) => {
    console.log('Main namespace connection:', {
      socketId: socket.id,
      transport: socket.conn?.transport?.name,
      timestamp: new Date().toISOString()
    });
  });

  // Track disconnections at the engine level
  io.engine.on('close', (socket: EngineSocket) => {
    console.log('Engine connection closed:', {
      socketId: socket.id,
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
      timestamp: new Date().toISOString(),
      activeConnections: connections.size
    });
  });

  const docNamespace = io.of('/document');

  // Authentication middleware with timeout
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    console.log('Document namespace connection attempt:', {
      socketId: socket.id,
      headers: socket.handshake.headers,
      auth: socket.handshake.auth,
      timestamp: new Date().toISOString()
    });

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

      console.log('Auth token check:', {
        socketId: socket.id,
        hasToken: !!token,
        authHeader: socket.handshake.headers.authorization,
        authObject: socket.handshake.auth,
        timestamp: new Date().toISOString()
      });

      if (!token) {
        clearTimeout(authTimeout);
        console.log('Authentication failed: No token provided', {
          socketId: socket.id,
          headers: socket.handshake.headers,
          auth: socket.handshake.auth
        });
        return next(new Error('Authentication required'));
      }

      try {
        console.log('Attempting to authenticate token:', {
          socketId: socket.id,
          tokenPrefix: token.substring(0, 10) + '...',
          timestamp: new Date().toISOString()
        });

        const userId = await authenticateUser(token);
        clearTimeout(authTimeout);
        
        if (!userId) {
          console.log('Authentication failed: Invalid token', {
            socketId: socket.id,
            timestamp: new Date().toISOString()
          });
          return next(new Error('Invalid token'));
        }

        socket.data.userId = userId;
        const conn = connections.get(socket.id);
        if (conn) {
          conn.userId = userId;
          conn.namespaces.add('/document');  // Track namespace connection
          connections.set(socket.id, conn);
        }
        
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name,
          activeConnections: connections.size,
          namespaces: conn?.namespaces.size || 0
        });
        
        next();
      } catch (error) {
        clearTimeout(authTimeout);
        console.error('Socket auth error:', {
          error,
          socketId: socket.id,
          timestamp: new Date().toISOString()
        });
        next(new Error('Authentication failed'));
      }
    } catch (error) {
      clearTimeout(authTimeout);
      console.error('Socket middleware error:', {
        error,
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication failed'));
    }
  });

  // Handle connections and disconnections in the document namespace
  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Client connected to document namespace:', {
      socketId: socket.id,
      userId: socket.data.userId,
      transport: socket.conn?.transport?.name,
      timestamp: new Date().toISOString()
    });

    // Handle document join
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

        // Update connection tracking
        const conn = connections.get(socket.id);
        if (conn) {
          conn.documentId = documentId;
          connections.set(socket.id, conn);
        }

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
    socket.on('disconnect', () => {
      const conn = connections.get(socket.id);
      connections.delete(socket.id);
      
      console.log('Client disconnected:', {
        socketId: socket.id,
        userId: socket.data.userId,
        documentId: socket.data.documentId,
        duration: conn ? Date.now() - conn.connectedAt.getTime() : 0,
        remainingConnections: connections.size,
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

  // Helper function to get accurate connection stats
  function getConnectionStats() {
    const uniqueConnections = new Set(Array.from(connections.values())
      .filter(conn => conn.lastPing 
        ? (Date.now() - conn.lastPing.getTime() < 30000) 
        : (Date.now() - conn.connectedAt.getTime() < 30000))
    );

    return {
      total: uniqueConnections.size,
      authenticated: Array.from(uniqueConnections).filter(c => c.authenticated).length,
      byTransport: {
        websocket: Array.from(uniqueConnections).filter(c => c.transport === 'websocket').length,
        polling: Array.from(uniqueConnections).filter(c => c.transport === 'polling').length
      },
      byNamespace: {
        document: Array.from(uniqueConnections).filter(c => c.namespaces.has('/document')).length
      },
      timestamp: new Date().toISOString()
    };
  }

  return io;
}