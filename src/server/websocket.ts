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

  // Create a separate HTTP server for WebSocket connections
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
    // Add these settings to prevent connection issues
    serveClient: false,
    destroyUpgrade: false,
    maxPayload: 1e8,
    allowRequest: (req: IncomingMessage, callback: (err: string | null, success: boolean) => void) => {
      // Always allow WebSocket connections
      callback(null, true);
    }
  });

  // Create document namespace with increased timeout
  const docNamespace = io.of('/document');
  docNamespace.setMaxListeners(20);

  // Add error handling for upgrade requests
  server.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
    console.log('WebSocket upgrade request:', {
      url: req.url,
      headers: {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        origin: req.headers.origin
      },
      timestamp: new Date().toISOString()
    });
  });

  // Add error handling for the engine
  io.engine.on('error', (err: Error) => {
    console.error('Engine error:', {
      error: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString()
    });
  });

  // Monitor initial connection attempts
  io.engine.on('initial_headers', (headers: Record<string, string>, req: IncomingMessage) => {
    console.log('Initial headers:', {
      url: req.url,
      method: req.method,
      headers: {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        origin: req.headers.origin
      },
      timestamp: new Date().toISOString()
    });
  });

  // Authentication middleware
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
        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name,
          timestamp: new Date().toISOString()
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

  // Add connection handling
  docNamespace.on('connection', (socket: DocumentSocket) => {
    console.log('Document namespace connection:', {
      socketId: socket.id,
      userId: socket.data.userId,
      transport: socket.conn?.transport?.name,
      timestamp: new Date().toISOString()
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('Client disconnected:', {
        socketId: socket.id,
        userId: socket.data.userId,
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

    // Handle document join
    socket.on('document:join', async (documentId: string) => {
      try {
        // Verify document access
        const document = await db.document.findUnique({
          where: { id: documentId },
          select: { id: true }
        });

        if (!document) {
          socket.emit('error', { message: 'Document not found' });
          return;
        }

        // Leave previous document if any
        if (socket.data.documentId) {
          socket.leave(socket.data.documentId);
        }

        // Join new document room
        socket.data.documentId = documentId;
        socket.join(documentId);

        // Notify client of successful join
        socket.emit('document:joined', {
          documentId,
          userId: socket.data.userId!
        });

        // Notify other clients in the document
        socket.to(documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.data.userId!,
          documentId,
          data: { status: 'online' }
        });

        console.log('Client joined document:', {
          socketId: socket.id,
          userId: socket.data.userId,
          documentId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error joining document:', error);
        socket.emit('error', { message: 'Failed to join document' });
      }
    });

    // Handle document updates
    socket.on('document:update', (data: DocumentUpdate) => {
      if (!socket.data.documentId || socket.data.documentId !== data.documentId) {
        socket.emit('error', { message: 'Not joined to document' });
        return;
      }

      // Broadcast update to other clients in the document
      socket.to(data.documentId).emit('document:update', data);
    });
  });

  return io;
}