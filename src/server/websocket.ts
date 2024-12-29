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

  // Add connection stabilization
  io.engine.on('connection', (rawSocket: any) => {
    // Set a higher timeout for the initial connection
    if (rawSocket.conn) {
      rawSocket.conn.setTimeout(60000);
    }

    // Monitor connection state
    const connectionState = {
      isUpgraded: false,
      hasError: false,
      lastActivity: Date.now(),
      closeReason: null as string | null,
      closeCode: null as string | number | null,
      upgradeAttempts: 0,
      authenticated: false,
      handshakeCompleted: false,
      authenticationAttempted: false
    };

    // Track initial connection
    console.log('Initial connection:', {
      socketId: rawSocket.id,
      transport: rawSocket.transport?.name,
      headers: rawSocket.request?.headers,
      auth: rawSocket.handshake?.auth,
      state: connectionState,
      timestamp: new Date().toISOString()
    });

    // Handle initial authentication
    const handleAuthentication = async (token: string) => {
      try {
        console.log('Starting engine-level authentication:', {
          socketId: rawSocket.id,
          tokenLength: token.length,
          fullToken: token,
          timestamp: new Date().toISOString()
        });

        // Check if token is in correct format
        if (!token.includes('.') || token.split('.').length !== 3) {
          console.error('Invalid token format:', {
            socketId: rawSocket.id,
            tokenLength: token.length,
            fullToken: token,
            timestamp: new Date().toISOString()
          });
          return false;
        }

        const userId = await authenticateUser(token);
        console.log('Authentication response:', {
          socketId: rawSocket.id,
          hasUserId: !!userId,
          userId,
          timestamp: new Date().toISOString()
        });

        if (userId) {
          connectionState.authenticated = true;
          connections.set(rawSocket.id, {
            userId,
            connectedAt: new Date(),
            transport: rawSocket.transport?.name || 'unknown',
            namespaces: new Set(['/document']),
            engineId: rawSocket.id,
            authenticated: true
          });
          console.log('Engine-level authentication successful:', {
            socketId: rawSocket.id,
            userId,
            timestamp: new Date().toISOString()
          });
          return true;
        } else {
          console.error('Authentication failed - no userId returned:', {
            socketId: rawSocket.id,
            timestamp: new Date().toISOString()
          });
          return false;
        }
      } catch (error) {
        console.error('Engine-level authentication error:', {
          socketId: rawSocket.id,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
            cause: error.cause
          } : error,
          timestamp: new Date().toISOString()
        });
        return false;
      }
    };

    // Check for token in handshake auth
    if (rawSocket.handshake?.auth?.token && !connectionState.authenticationAttempted) {
      connectionState.authenticationAttempted = true;
      console.log('Found token in handshake auth:', {
        socketId: rawSocket.id,
        tokenLength: rawSocket.handshake.auth.token.length,
        fullToken: rawSocket.handshake.auth.token,
        timestamp: new Date().toISOString()
      });
      handleAuthentication(rawSocket.handshake.auth.token).catch(error => {
        console.error('Handshake auth error:', {
          socketId: rawSocket.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      });
    }

    // Track handshake completion
    rawSocket.on('handshake', (handshake: any) => {
      connectionState.handshakeCompleted = true;
      console.log('Handshake completed:', {
        socketId: rawSocket.id,
        handshake,
        state: connectionState,
        timestamp: new Date().toISOString()
      });
    });

    // Track errors with more detail
    rawSocket.on('error', (error: Error) => {
      connectionState.hasError = true;
      console.error('Socket error:', {
        socketId: rawSocket.id,
        error: error.message,
        stack: error.stack,
        state: connectionState,
        transport: rawSocket.transport?.name,
        headers: rawSocket.request?.headers,
        timestamp: new Date().toISOString()
      });
    });

    // Monitor close with more detail
    rawSocket.on('close', (code: number | string, reason: string) => {
      connectionState.closeCode = code;
      connectionState.closeReason = reason;
      console.log('Socket closed:', {
        socketId: rawSocket.id,
        code,
        reason,
        state: connectionState,
        timeSinceLastActivity: Date.now() - connectionState.lastActivity,
        wasUpgraded: connectionState.isUpgraded,
        wasAuthenticated: connectionState.authenticated,
        handshakeCompleted: connectionState.handshakeCompleted,
        transport: rawSocket.transport?.name,
        headers: rawSocket.request?.headers,
        timestamp: new Date().toISOString()
      });
    });

    // Track all packets for debugging
    rawSocket.on('packet', async (packet: any) => {
      connectionState.lastActivity = Date.now();
      
      // Log the packet details
      if (packet.type === 'message') {
        try {
          // Try to parse the data if it's a message
          const data = typeof packet.data === 'string' ? JSON.parse(packet.data.substring(1)) : packet.data;
          console.log('Message packet received:', {
            socketId: rawSocket.id,
            type: packet.type,
            messageType: packet.data.charAt(0),
            data: data.token ? { ...data, fullToken: data.token } : data,
            state: connectionState,
            timestamp: new Date().toISOString()
          });

          // Handle authentication message (type 0 is connect)
          if (packet.data.charAt(0) === '0' && data.token && !connectionState.authenticationAttempted) {
            connectionState.authenticationAttempted = true;
            console.log('Processing authentication token from message:', {
              socketId: rawSocket.id,
              state: connectionState,
              tokenLength: data.token.length,
              fullToken: data.token,
              timestamp: new Date().toISOString()
            });

            const success = await handleAuthentication(data.token);
            if (!success) {
              console.log('Closing connection due to authentication failure:', {
                socketId: rawSocket.id,
                state: connectionState,
                timestamp: new Date().toISOString()
              });
              rawSocket.close();
            }
          }
        } catch (error) {
          console.log('Packet received (parse error):', {
            socketId: rawSocket.id,
            type: packet.type,
            data: packet.data,
            error: error instanceof Error ? error.message : 'Unknown error',
            state: connectionState,
            timestamp: new Date().toISOString()
          });
        }
      } else {
        console.log('Packet received:', {
          socketId: rawSocket.id,
          type: packet.type,
          data: packet.data,
          state: connectionState,
          timestamp: new Date().toISOString()
        });
      }
    });
  });

  // Create document namespace with authentication requirement
  const docNamespace = io.of('/document');

  // Authentication middleware
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    console.log('Authentication attempt:', {
      socketId: socket.id,
      headers: socket.handshake.headers,
      query: socket.handshake.query,
      auth: socket.handshake.auth,
      timestamp: new Date().toISOString()
    });

    const authTimeout = setTimeout(() => {
      console.error('Authentication timeout:', {
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication timeout'));
    }, 10000);

    try {
      const token = socket.handshake.headers.authorization?.split(' ')[1];

      if (!token) {
        clearTimeout(authTimeout);
        console.log('Authentication failed: No token provided', {
          socketId: socket.id,
          headers: socket.handshake.headers,
          timestamp: new Date().toISOString()
        });
        return next(new Error('Authentication required'));
      }

      try {
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
          transport: socket.conn.transport.name,
          timestamp: new Date().toISOString()
        });
        
        next();
      } catch (error) {
        clearTimeout(authTimeout);
        console.error('Socket auth error:', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString()
        });
        next(new Error('Authentication failed'));
      }
    } catch (error) {
      clearTimeout(authTimeout);
      console.error('Socket middleware error:', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      next(new Error('Authentication failed'));
    }
  });

  // Connection monitoring
  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Client connected to document namespace:', {
      socketId: socket.id,
      userId: socket.data.userId,
      transport: socket.conn.transport.name,
      headers: socket.handshake.headers,
      timestamp: new Date().toISOString()
    });

    // Monitor socket errors
    socket.on('error', (error: Error) => {
      console.error('Socket error:', {
        socketId: socket.id,
        userId: socket.data.userId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    });

    // Monitor disconnection with reason
    socket.on('disconnect', (reason: string) => {
      const conn = connections.get(socket.id);
      connections.delete(socket.id);
      
      console.log('Client disconnected:', {
        socketId: socket.id,
        userId: socket.data.userId,
        documentId: socket.data.documentId,
        reason,
        wasAuthenticated: !!socket.data.userId,
        duration: conn ? Date.now() - conn.connectedAt.getTime() : 0,
        transport: socket.conn?.transport?.name,
        pingTimeout: socket.conn?.transport?.pingTimeout,
        timestamp: new Date().toISOString()
      });

      // Notify other clients if the user was in a document
      if (socket.data.documentId && socket.data.userId) {
        socket.to(socket.data.documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.data.userId,
          documentId: socket.data.documentId,
          data: { 
            status: 'offline',
            reason
          }
        });
      }
    });

    // Monitor connection state
    socket.conn.on('packet', (packet: any) => {
      if (packet.type === 'ping' || packet.type === 'pong') {
        console.log('Heartbeat:', {
          socketId: socket.id,
          userId: socket.data.userId,
          type: packet.type,
          timestamp: new Date().toISOString()
        });
      }
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
  });

  return io;
}