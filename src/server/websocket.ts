import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { authenticateUser } from './auth';
import { db } from './db';
import { Prisma } from '@prisma/client';

interface DocumentSocket extends Socket {
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
  try {
    // Verify document access
    const document = await db.document.findFirst({
      where: {
        id: data.documentId,
        users: {
          some: {
            id: socket.userId!
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
            user: { connect: { id: socket.userId! } }
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

  const io = new Server(server, {
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
      methods: ['GET', 'POST'],
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type']
    },
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 20000,
    connectTimeout: 20000,
    transports: ['websocket'],
    allowUpgrades: false,
    maxHttpBufferSize: 1e8,
    perMessageDeflate: {
      threshold: 1024
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    }
  });

  // Add error handling for the server
  io.engine.on('connection_error', (err: Error) => {
    console.error('Connection error:', err);
  });

  // Log all engine events for debugging
  io.engine.on('initial_headers', (headers: any, req: any) => {
    console.log('Initial headers:', headers);
  });

  io.engine.on('headers', (headers: any, req: any) => {
    console.log('Headers:', headers);
  });

  io.engine.on('upgrade', (req: any) => {
    console.log('Engine upgrade event:', req.url);
  });

  // Authentication middleware
  io.use(async (socket: DocumentSocket, next) => {
    try {
      console.log('Authenticating socket connection...', {
        auth: socket.handshake.auth,
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        id: socket.id
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
        console.log('Socket authenticated for user:', userId, 'socket:', socket.id);
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

  io.on('connection', async (socket: DocumentSocket) => {
    console.log('Client connected:', socket.userId);

    // Handle document join
    socket.on('document:join', async (documentId: string) => {
      try {
        // Verify document access
        const document = await db.document.findFirst({
          where: {
            id: documentId,
            users: {
              some: {
                id: socket.userId!
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
      console.log('Client disconnected:', socket.userId);
      if (socket.documentId) {
        // Notify other clients in the room
        socket.to(socket.documentId).emit('document:presence', {
          type: 'presence',
          userId: socket.userId,
          documentId: socket.documentId,
          data: { status: 'offline' }
        });
      }
    });
  });

  return io;
}