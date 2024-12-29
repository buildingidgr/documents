import { Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket } from 'socket.io';
import { db } from './db';
import { authenticateUser } from './auth';
import { Prisma } from '@prisma/client';

// Define custom events
interface ServerToClientEvents {
  'error': (data: { message: string }) => void;
  'document:joined': (data: { documentId: string; userId: string }) => void;
  'document:update': (data: DocumentUpdate) => void;
  'document:cursor': (data: DocumentUpdate) => void;
  'document:presence': (data: DocumentUpdate) => void;
}

interface ClientToServerEvents {
  'document:join': (documentId: string) => void;
  'document:update': (data: DocumentUpdate) => void;
  'document:cursor': (data: DocumentUpdate) => void;
  'document:presence': (data: DocumentUpdate) => void;
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
  userId?: string;
  documentId?: string;
}

interface DocumentUpdate {
  type: 'update' | 'cursor' | 'presence';
  documentId: string;
  userId: string;
  data: any;
}

async function handleDocumentUpdate(
  socket: DocumentSocket,
  data: DocumentUpdate
) {
  if (!socket.userId) {
    socket.emit('error', { message: 'Not authenticated' });
    return;
  }

  try {
    // Verify document access
    const document = await db.document.findFirst({
      where: {
        id: data.documentId,
        users: {
          some: {
            id: socket.userId
          }
        }
      }
    });

    if (!document) {
      console.log('Document update access denied:', data.documentId);
      socket.emit('error', { message: 'Document access denied' });
      return;
    }

    // Update document in database
    await db.document.update({
      where: { id: data.documentId },
      data: {
        content: data.data.content as Prisma.InputJsonValue,
        versions: {
          create: {
            content: data.data.content as Prisma.InputJsonValue,
            user: { connect: { id: socket.userId } }
          }
        }
      }
    });

    // Broadcast update to other clients in the room
    socket.to(data.documentId).emit('document:update', {
      type: 'update',
      userId: socket.userId,
      documentId: data.documentId,
      data: data.data
    });
  } catch (error) {
    console.error('Document update error:', error);
    socket.emit('error', { message: 'Failed to update document' });
  }
}

async function handleCursorUpdate(
  socket: DocumentSocket,
  data: DocumentUpdate
) {
  if (!socket.userId) {
    socket.emit('error', { message: 'Not authenticated' });
    return;
  }

  // Broadcast cursor position to other clients in the room
  socket.to(data.documentId).emit('document:cursor', {
    type: 'cursor',
    userId: socket.userId,
    documentId: data.documentId,
    data: data.data
  });
}

async function handlePresenceUpdate(
  socket: DocumentSocket,
  data: DocumentUpdate
) {
  if (!socket.userId) {
    socket.emit('error', { message: 'Not authenticated' });
    return;
  }

  // Broadcast presence update to other clients in the room
  socket.to(data.documentId).emit('document:presence', {
    type: 'presence',
    userId: socket.userId,
    documentId: data.documentId,
    data: data.data
  });
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up Socket.IO server...');

  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(server, {
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
        'chrome-extension://ophmdkgfcjapomjdpfobjfbihojchbko'
      ],
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      credentials: true
    },
    // Configure transport settings
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
    upgradeTimeout: 10000,
    // Configure timeouts
    pingInterval: 10000,
    pingTimeout: 5000,
    connectTimeout: 45000,
    // Configure connection state recovery
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
    // Configure perMessageDeflate
    perMessageDeflate: {
      threshold: 1024,
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      zlibDeflateOptions: {
        level: 6
      }
    }
  });

  // Create a dedicated namespace for document collaboration
  const docNamespace = io.of('/document');

  // Track connected sockets by user ID
  const connectedSockets = new Map<string, Set<string>>();

  // Authentication middleware for document namespace
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    try {
      console.log('Authenticating socket connection...', {
        auth: socket.handshake.auth,
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        id: socket.id,
        transport: socket.conn?.transport?.name
      });

      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Remove 'Bearer ' prefix if present
      const cleanToken = token.replace('Bearer ', '');
      
      try {
        const userId = await authenticateUser(cleanToken);
        if (!userId) {
          return next(new Error('Invalid token'));
        }
        
        socket.userId = userId;

        // Track the socket connection
        if (!connectedSockets.has(userId)) {
          connectedSockets.set(userId, new Set());
        }
        connectedSockets.get(userId)?.add(socket.id);

        console.log('Socket authenticated:', {
          userId,
          socketId: socket.id,
          transport: socket.conn?.transport?.name
        });
        
        next();
      } catch (error) {
        console.error('Token validation error:', error);
        return next(new Error('Authentication failed'));
      }
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Authentication failed'));
    }
  });

  docNamespace.on('connection', async (socket: DocumentSocket) => {
    console.log('Client connected:', socket.userId, 'namespace:', socket.nsp.name);

    // Handle document join
    socket.on('document:join', async (documentId: string) => {
      try {
        if (!socket.userId) {
          socket.emit('error', { message: 'Not authenticated' });
          return;
        }

        // Verify document access
        const document = await db.document.findFirst({
          where: {
            id: documentId,
            users: {
              some: {
                id: socket.userId
              }
            }
          }
        });

        if (!document) {
          socket.emit('error', { message: 'Document access denied' });
          return;
        }

        // Leave previous document room if any
        if (socket.documentId) {
          socket.leave(socket.documentId);
        }

        // Join new document room
        socket.documentId = documentId;
        socket.join(documentId);

        // Notify client of successful join
        socket.emit('document:joined', {
          documentId,
          userId: socket.userId
        });

        // Notify other clients in the room
        socket.to(documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.userId,
          documentId: documentId,
          data: { status: 'online' }
        });
      } catch (error) {
        console.error('Error joining document:', error);
        socket.emit('error', { message: 'Failed to join document' });
      }
    });

    // Handle document updates
    socket.on('document:update', (data: DocumentUpdate) => {
      handleDocumentUpdate(socket, data);
    });

    // Handle cursor updates
    socket.on('document:cursor', (data: DocumentUpdate) => {
      handleCursorUpdate(socket, data);
    });

    // Handle presence updates
    socket.on('document:presence', (data: DocumentUpdate) => {
      handlePresenceUpdate(socket, data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.userId, 'namespace:', socket.nsp.name);
      // Clean up the socket tracking
      if (socket.userId) {
        const userSockets = connectedSockets.get(socket.userId);
        if (userSockets) {
          userSockets.delete(socket.id);
          if (userSockets.size === 0) {
            connectedSockets.delete(socket.userId);
          }
        }
      }
      // Force socket cleanup
      socket.removeAllListeners();
    });
  });

  return io;
}