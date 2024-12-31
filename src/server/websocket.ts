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

// Add Socket.IO transport types at the top with other interfaces
interface EngineTransport {
  name: string;
  writable: boolean;
  readable: boolean;
  sid?: string;
}

interface EngineError extends Error {
  code?: string;
  transport?: string;
  description?: string;
}

// Add Plate.js types
interface PlateText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  [key: string]: any; // For other formatting marks
}

interface PlateElement {
  type: string;
  children: (PlateElement | PlateText)[];
  [key: string]: any; // For other element attributes
}

interface PlateDocument {
  type: 'doc';
  content: PlateElement[];
}

interface DocumentUpdate {
  type: 'update';
  documentId: string;
  userId: string;
  data: {
    content: PlateDocument;
  };
}

interface ServerToClientEvents {
  'error': (data: { message: string }) => void;
  'document:joined': (data: { documentId: string; userId: string }) => void;
  'document:update': (data: DocumentUpdate) => void;
  'document:presence': (data: { type: string; userId: string; documentId: string; data: any }) => void;
  'pong': (data: { timestamp: string }) => void;
}

interface ClientToServerEvents {
  'document:join': (documentId: string) => void;
  'document:update': (data: DocumentUpdate) => void;
  'disconnect': () => void;
  'ping': (callback: (data: { timestamp: string }) => void) => void;
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
    path: '/socket.io/',
    cors: {
      origin: async (origin, callback) => {
        console.log('CORS check for origin:', origin);
        // Always allow localhost for development
        if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
          console.log('Allowing localhost origin');
          callback(null, true);
          return;
        }

        try {
          // Allow all origins in production for now, including VS Code Live Share
          console.log('Allowing origin in production:', origin);
          callback(null, true);
        } catch (error) {
          console.error('CORS error:', error);
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Accept"],
      credentials: true
    },
    // Connection settings
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 45000,  // Increased timeout for proxy
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
    // Add proxy support
    allowRequest: (req: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
      // Log headers for debugging
      console.log('Socket.IO request headers:', {
        headers: req.headers,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
      });
      callback(null, true);
    }
  });

  // Attach to server after configuration
  io.attach(server);

  // Add connection retry logic
  io.engine.on('connection_error', (err: { message: string; code?: string; type?: string }) => {
    console.error('Connection error:', {
      error: err.message,
      code: err.code,
      type: err.type,
      timestamp: new Date().toISOString()
    });
  });

  // Monitor transport changes with more detail
  io.engine.on('connection', (socket: any) => {
    console.log('New engine connection:', {
      id: socket.id,
      transport: socket.transport?.name,
      headers: socket.request?.headers,
      timestamp: new Date().toISOString()
    });

    socket.on('upgrade', (transport: EngineTransport) => {
      console.log('Transport upgraded:', {
        id: socket.id,
        from: socket.transport?.name,
        to: transport.name,
        timestamp: new Date().toISOString()
      });
    });

    socket.on('upgradeError', (err: EngineError) => {
      console.error('Transport upgrade error:', {
        id: socket.id,
        transport: socket.transport?.name,
        error: err.message,
        code: err.code,
        timestamp: new Date().toISOString()
      });
    });

    // Monitor close events
    socket.on('close', (reason: string) => {
      console.log('Engine socket closed:', {
        id: socket.id,
        reason,
        transport: socket.transport?.name,
        timestamp: new Date().toISOString()
      });
    });
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
    console.log('Client connected with details:', {
      socketId: socket.id,
      userId: socket.data.userId,
      transport: socket.conn.transport.name,
      handshake: {
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        auth: socket.handshake.auth
      },
      timestamp: new Date().toISOString()
    });

    // Handle custom ping events
    socket.on('ping', (callback) => {
      console.log('Received ping from client:', {
        socketId: socket.id,
        userId: socket.data.userId,
        timestamp: new Date().toISOString()
      });
      
      // Send pong response
      const response = { timestamp: new Date().toISOString() };
      if (typeof callback === 'function') {
        callback(response);
      } else {
        socket.emit('pong', response);
      }
    });

    // Log all incoming events for debugging
    socket.onAny((eventName, ...args) => {
      console.log('Received event:', {
        event: eventName,
        args,
        socketId: socket.id,
        userId: socket.data.userId,
        timestamp: new Date().toISOString()
      });
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
        console.log('Received document update:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId: data.documentId,
          type: data.type,
          timestamp: new Date().toISOString()
        });

        // Validate the update structure
        if (!data.data?.content?.type || data.data.content.type !== 'doc') {
          throw new Error('Invalid content structure');
        }

        // Validate content elements
        const validateElement = (element: PlateElement | PlateText): boolean => {
          if ('text' in element) {
            // Text node validation
            return typeof element.text === 'string';
          }
          
          // Element node validation
          if (!element.type || !Array.isArray(element.children)) {
            return false;
          }
          
          // Recursively validate children
          return element.children.every(child => validateElement(child));
        };

        const isValid = data.data.content.content.every(element => validateElement(element));
        if (!isValid) {
          throw new Error('Invalid content structure');
        }

        // Set userId from authenticated socket
        data.userId = socket.data.userId!;

        // Broadcast the update to others in the document
        socket.to(data.documentId).emit('document:update', data);

        console.log('Document update broadcast:', {
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