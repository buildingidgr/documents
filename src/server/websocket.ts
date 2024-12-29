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
  disconnect: (close?: boolean) => void;
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
    state: 'connecting' | 'authenticating' | 'authenticated' | 'closed';
    authTimeout?: ReturnType<typeof setTimeout>;
  }>();

  // Helper function to get accurate connection stats
  function getConnectionStats() {
    const uniqueConnections = new Set(Array.from(connections.values())
      .filter(conn => conn.lastPing 
        ? (Date.now() - conn.lastPing.getTime() < 30000) 
        : (Date.now() - conn.connectedAt.getTime() < 30000))
    );

    return {
      total: uniqueConnections.size,
      authenticated: Array.from(uniqueConnections).filter(c => c.userId).length,
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

  const docNamespace = io.of('/document');

  // Track connection attempts before upgrade
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const connectionId = Math.random().toString(36).substring(7);
    console.log('Pre-upgrade connection attempt:', {
      id: connectionId,
      url: req.url,
      headers: {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        origin: req.headers.origin
      },
      timestamp: new Date().toISOString()
    });

    // Prevent premature socket closure
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });

  // Add connection monitoring with state tracking
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
    
    // Initialize connection state
    connections.set(socket.id, {
      connectedAt: new Date(),
      transport: socket.transport?.name || 'unknown',
      namespaces: new Set(),
      state: 'connecting'
    });

    // Set a timeout for initial authentication
    const authTimeout = setTimeout(() => {
      const conn = connections.get(socket.id);
      if (conn && conn.state === 'connecting') {
        console.log('Connection authentication timeout:', {
          socketId: socket.id,
          state: conn.state,
          timestamp: new Date().toISOString()
        });
        socket.disconnect(true);
      }
    }, 10000); // 10 second timeout for initial authentication

    const conn = connections.get(socket.id);
    if (conn) {
      conn.authTimeout = authTimeout;
      connections.set(socket.id, conn);
    }

    // Log connection stats
    const stats = getConnectionStats();
    console.log('Connection stats:', {
      ...stats,
      engineConnections: io.engine.clientsCount,
      namespaceConnections: docNamespace.sockets.size
    });
  });

  // Monitor all packet types for connection health
  io.engine.on('packet', (packet: any, socket: EngineSocket) => {
    const conn = connections.get(socket.id);
    if (conn) {
      conn.lastPing = new Date();
      
      // Log packet for debugging
      console.log('Socket packet:', {
        socketId: socket.id,
        type: packet.type,
        state: conn.state,
        timestamp: new Date().toISOString()
      });

      connections.set(socket.id, conn);
    }
  });

  // Handle disconnections at engine level
  io.engine.on('close', (socket: EngineSocket) => {
    const conn = connections.get(socket.id);
    if (conn) {
      // Clear any pending timeouts
      if (conn.authTimeout) {
        clearTimeout(conn.authTimeout);
      }
      
      console.log('Engine connection closed:', {
        socketId: socket.id,
        state: conn.state,
        duration: Date.now() - conn.connectedAt.getTime(),
        timestamp: new Date().toISOString()
      });
      
      connections.delete(socket.id);
    }
  });

  // Authentication middleware with state tracking
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    const conn = connections.get(socket.id);
    if (conn) {
      conn.state = 'authenticating';
      connections.set(socket.id, conn);
    }

    console.log('Document namespace connection attempt:', {
      socketId: socket.id,
      headers: socket.handshake.headers,
      auth: socket.handshake.auth,
      connectionState: conn?.state,
      timestamp: new Date().toISOString()
    });

    try {
      const token = socket.handshake.auth.token || 
                    socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        console.log('Authentication failed: No token provided', {
          socketId: socket.id,
          connectionState: conn?.state
        });
        return next(new Error('Authentication required'));
      }

      const userId = await authenticateUser(token);
      
      if (!userId) {
        console.log('Authentication failed: Invalid token', {
          socketId: socket.id,
          connectionState: conn?.state
        });
        return next(new Error('Invalid token'));
      }

      socket.data.userId = userId;
      if (conn) {
        conn.userId = userId;
        conn.state = 'authenticated';
        conn.namespaces.add('/document');
        // Clear auth timeout as authentication succeeded
        if (conn.authTimeout) {
          clearTimeout(conn.authTimeout);
          conn.authTimeout = undefined;
        }
        connections.set(socket.id, conn);
      }
      
      console.log('Socket authenticated:', {
        userId,
        socketId: socket.id,
        transport: socket.conn?.transport?.name,
        connectionState: conn?.state,
        namespaces: conn?.namespaces.size || 0
      });
      
      next();
    } catch (error) {
      console.error('Authentication error:', {
        socketId: socket.id,
        error,
        connectionState: conn?.state
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

  return io;
}