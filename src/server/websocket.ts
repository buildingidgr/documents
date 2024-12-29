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
    transports: ['websocket'],
    pingInterval: 10000,
    pingTimeout: 5000,
    connectTimeout: 45000,
    maxHttpBufferSize: 1e8
  });

  // Create a dedicated namespace for document collaboration
  const docNamespace = io.of('/document');

  // Track connected sockets by user ID
  const connectedSockets = new Map<string, Set<string>>();

  // Handle upgrade requests before Socket.IO
  server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const isWebSocketRequest = req.headers.upgrade?.toLowerCase() === 'websocket';
    const isWebSocketPath = req.url?.startsWith('/ws');
    
    if (!isWebSocketRequest || !isWebSocketPath) {
      console.log('Rejected non-WebSocket upgrade request:', {
        path: req.url,
        upgrade: req.headers.upgrade
      });
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    // Let Socket.IO handle the upgrade
    console.log('Forwarding WebSocket upgrade request to Socket.IO:', {
      path: req.url,
      headers: {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        'sec-websocket-key': req.headers['sec-websocket-key']
      }
    });
  });

  // Add error handlers for the server instance
  io.engine.on('connection_error', (err: Error) => {
    console.error('Socket.IO connection error:', {
      error: err.message,
      name: err.name,
      stack: err.stack
    });
  });

  // Authentication middleware for document namespace
  docNamespace.use(async (socket: DocumentSocket, next: (err?: Error) => void) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];
      if (!token) {
        console.log('Authentication failed: No token provided');
        return next(new Error('Authentication required'));
      }

      const cleanToken = token.replace('Bearer ', '');
      
      try {
        const userId = await authenticateUser(cleanToken);
        if (!userId) {
          console.log('Authentication failed: Invalid token');
          return next(new Error('Invalid token'));
        }
        
        socket.userId = userId;
        socket.conn.on('packet', (packet) => {
          console.log('Received packet:', {
            type: packet.type,
            socketId: socket.id,
            userId: socket.userId
          });
        });

        socket.conn.on('error', (error) => {
          console.error('Socket connection error:', {
            error,
            socketId: socket.id,
            userId: socket.userId
          });
        });

        // Track the socket connection
        if (!connectedSockets.has(userId)) {
          connectedSockets.set(userId, new Set());
        }
        connectedSockets.get(userId)?.add(socket.id);

        console.log('Socket authenticated successfully:', {
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
    console.log('Client connected to document namespace:', {
      userId: socket.userId,
      socketId: socket.id,
      transport: socket.conn?.transport?.name
    });

    // Add connection error handler
    socket.conn.on('error', (error) => {
      console.error('Socket connection error:', {
        error,
        socketId: socket.id,
        userId: socket.userId
      });
    });

    // Add ping timeout handler
    socket.conn.on('ping timeout', () => {
      console.log('Ping timeout detected:', {
        socketId: socket.id,
        userId: socket.userId,
        transport: socket.conn?.transport?.name
      });
    });

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
    socket.on('disconnect', (reason) => {
      console.log('Client disconnected:', {
        reason,
        userId: socket.userId,
        socketId: socket.id,
        namespace: socket.nsp.name
      });

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