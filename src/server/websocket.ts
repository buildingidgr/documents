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
    engineId?: string;  // Track the engine socket ID
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
    },
    // Add these options to handle middleware interference
    allowRequest: (req: IncomingMessage, callback: AllowRequestCallback) => {
      // Always allow WebSocket connections
      callback(null, true);
    },
    addTrailingSlash: false,  // Prevent redirect issues
    destroyUpgrade: false,    // Keep upgrade requests alive
    serveClient: false,       // Don't serve client files
    maxPayload: 1e8          // 100MB max payload
  });

  // Create document namespace
  const docNamespace = io.of('/document');
  
  // Set higher max listeners if needed
  docNamespace.setMaxListeners(20);  // Increase from default 10 to 20

  // Helper function to get accurate connection stats
  function getConnectionStats() {
    const now = Date.now();
    const activeConnections = Array.from(connections.values()).filter(conn => {
      const lastActivity = conn.lastPing || conn.connectedAt;
      return now - lastActivity.getTime() < 60000; // Consider connections active for 60s
    });

    return {
      total: activeConnections.length,
      authenticated: activeConnections.filter(c => c.authenticated).length,
      byTransport: {
        websocket: activeConnections.filter(c => c.transport === 'websocket').length,
        polling: activeConnections.filter(c => c.transport === 'polling').length
      },
      byNamespace: {
        document: activeConnections.filter(c => c.namespaces.has('/document')).length
      },
      timestamp: new Date().toISOString()
    };
  }

  // Add connection monitoring
  io.engine.on('connection', (socket: EngineSocket & { request: IncomingMessage }) => {
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
    
    // Only add to connections if it doesn't exist
    if (!connections.has(socket.id)) {
      connections.set(socket.id, {
        connectedAt: new Date(),
        transport: socket.transport?.name || 'unknown',
        namespaces: new Set(),
        authenticated: false,
        engineId: socket.transport?.sid || socket.id  // Use transport sid if available
      });

      // Log accurate connection stats
      const stats = getConnectionStats();
      console.log('Connection stats:', stats);
    }

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (connections.has(socket.id)) {
        const conn = connections.get(socket.id);
        if (conn && !conn.userId) {  // Only timeout unauthenticated connections
          console.log('Connection timeout - no authentication attempt:', {
            socketId: socket.id,
            engineId: socket.transport?.sid,
            duration: Date.now() - conn.connectedAt.getTime(),
            timestamp: new Date().toISOString()
          });
          connections.delete(socket.id);
        }
      }
    }, 10000); // 10 second timeout for authentication attempt

    // Handle cleanup
    const cleanup = () => {
      clearTimeout(connectionTimeout);
      connections.delete(socket.id);
    };

    // Clear timeout on authentication or disconnection
    const connectionHandler = (socket: DocumentSocket) => {
      clearTimeout(connectionTimeout);
    };

    // Add the listener with a unique name
    const listenerName = `connection-${socket.id}`;
    docNamespace.on('connection', connectionHandler);

    // Handle socket closure and cleanup
    if (socket.request && socket.request.socket) {
      socket.request.socket.once('close', () => {
        cleanup();
        // Remove the connection listener
        docNamespace.removeListener('connection', connectionHandler);
      });
    }
  });

  // Monitor heartbeats for all sockets
  docNamespace.on('connection', (socket: DocumentSocket) => {
    // Find the engine connection using the public method
    const engineId = socket.conn.transport.sid;
    const engineConn = Array.from(connections.values()).find(c => c.engineId === engineId);
    
    if (engineConn) {
      // Update the namespace connection with engine connection info
      const conn = connections.get(socket.id);
      if (conn) {
        conn.engineId = engineId;
        conn.lastPing = engineConn.lastPing;
        connections.set(socket.id, conn);
      }
    }

    // Handle heartbeats
    const updateLastPing = () => {
      const conn = connections.get(socket.id);
      if (conn) {
        conn.lastPing = new Date();
        connections.set(socket.id, conn);
        console.log('Heartbeat received:', {
          socketId: socket.id,
          engineId: engineId,
          userId: socket.data.userId,
          authenticated: conn.authenticated,
          timestamp: new Date().toISOString()
        });
      }
    };

    // Update on both ping and connection events
    const packetHandler = (packet: any) => {
      if (packet.type === 'ping' || packet.type === 'pong') {
        updateLastPing();
      }
    };
    socket.conn.on('packet', packetHandler);

    // Clean up listeners on disconnect
    socket.on('disconnect', () => {
      socket.conn.removeListener('packet', packetHandler);
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

  // Monitor ping/pong to track active connections
  io.engine.on('packet', (packet: any, socket: EngineSocket) => {
    if (packet.type === 'ping' || packet.type === 'pong') {
      // Try to find connection by engine ID or socket ID
      let conn = connections.get(socket.id);
      
      if (!conn) {
        // Search for connection by engineId if not found by socket.id
        conn = Array.from(connections.values()).find(c => c.engineId === socket.id);
      }

      if (conn) {
        conn.lastPing = new Date();
        connections.set(socket.id, conn);
        console.log('Ping/Pong received:', {
          socketId: socket.id,
          type: packet.type,
          authenticated: conn.authenticated,
          userId: conn.userId,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  // Clean up stale connections periodically
  setInterval(() => {
    const now = Date.now();
    connections.forEach((conn, id) => {
      const lastActivity = conn.lastPing || conn.connectedAt;
      const inactiveTime = now - lastActivity.getTime();
      
      // More lenient cleanup rules:
      // - Unauthenticated: Remove after 60s of inactivity
      // - Authenticated without ping: Remove after 5 minutes
      // - Authenticated with recent ping: Keep alive
      if ((!conn.authenticated && inactiveTime > 60000) || 
          (conn.authenticated && !conn.lastPing && inactiveTime > 300000) ||
          (conn.authenticated && conn.lastPing && inactiveTime > 600000)) {
        console.log('Removing stale connection:', {
          socketId: id,
          userId: conn.userId,
          authenticated: conn.authenticated,
          lastPing: conn.lastPing?.toISOString(),
          connectedAt: conn.connectedAt.toISOString(),
          inactiveFor: Math.floor(inactiveTime / 1000) + 's',
          timestamp: new Date().toISOString()
        });
        connections.delete(id);
      } else {
        // Log activity for active connections
        console.log('Active connection status:', {
          socketId: id,
          userId: conn.userId,
          authenticated: conn.authenticated,
          lastPing: conn.lastPing?.toISOString(),
          inactiveFor: Math.floor(inactiveTime / 1000) + 's',
          timestamp: new Date().toISOString()
        });
      }
    });
    
    // Log current stats after cleanup
    const stats = getConnectionStats();
    console.log('Connection stats after cleanup:', {
      ...stats,
      rawActiveConnections: io.engine.clientsCount,
      namespaceConnections: docNamespace.sockets.size,
      detailedConnections: Array.from(connections.entries()).map(([id, conn]) => ({
        socketId: id,
        userId: conn.userId,
        authenticated: conn.authenticated,
        lastPing: conn.lastPing?.toISOString(),
        connectedAt: conn.connectedAt.toISOString()
      }))
    });
  }, 30000); // Every 30 seconds

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
    const conn = connections.get(socket.id);
    if (conn) {
      console.log('Engine connection closed:', {
        socketId: socket.id,
        userId: conn.userId,
        authenticated: !!conn.userId,
        duration: Date.now() - conn.connectedAt.getTime(),
        namespaces: Array.from(conn.namespaces),
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

  // Authentication middleware with timeout
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    console.log('Document namespace connection attempt:', {
      socketId: socket.id,
      headers: socket.handshake.headers,
      auth: socket.handshake.auth,
      timestamp: new Date().toISOString()
    });

    // Create or update connection tracking for namespace socket
    let conn = connections.get(socket.id);
    if (!conn) {
      conn = {
        connectedAt: new Date(),
        transport: socket.conn?.transport?.name || 'unknown',
        namespaces: new Set(['/document']),
        authenticated: false
      };
      connections.set(socket.id, conn);
    }

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
        console.log('Authentication failed: No token provided', {
          socketId: socket.id,
          headers: socket.handshake.headers,
          auth: socket.handshake.auth
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
        conn.userId = userId;
        conn.authenticated = true;
        connections.set(socket.id, conn);
        
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name,
          activeConnections: connections.size,
          namespaces: conn.namespaces.size
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

  // Add middleware for all namespaces
  io.use((socket: Socket, next: (err?: Error) => void) => {
    console.log('Global middleware - connection attempt:', {
      socketId: socket.id,
      transport: socket.conn?.transport?.name,
      headers: socket.handshake.headers,
      timestamp: new Date().toISOString()
    });
    next();
  });

  // Add error handling for the engine
  io.engine.on('error', (err: Error) => {
    console.error('Engine error:', {
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
  });

  return io;
}