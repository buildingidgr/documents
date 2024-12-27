import WebSocket, { RawData } from 'ws'
import { WebSocketServer } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'http'
import { authenticateUser } from './auth'
import { db } from './db'
import { Prisma } from '@prisma/client'
import { parse as parseUrl } from 'url'

interface DocumentWebSocket extends WebSocket {
  documentId?: string
  userId?: string
  isAlive?: boolean
}

interface DocumentUpdate {
  type: 'update' | 'cursor' | 'presence'
  documentId: string
  userId: string
  data: any
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up WebSocket server...');
  
  const wss = new WebSocketServer({ 
    noServer: true, // Don't attach to server automatically
    clientTracking: true,
    perMessageDeflate: false, // Disable compression
    maxPayload: 1024 * 1024, // 1MB max message size
    backlog: 100 // Maximum length of the queue of pending connections
  });

  console.log('WebSocket server created');

  // Handle upgrade requests
  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    console.log('Upgrade request received');
    console.log('Connection URL:', request.url);
    console.log('Headers:', request.headers);

    const { pathname, query } = parseUrl(request.url || '', true);
    
    // Verify path
    if (pathname !== '/ws' && pathname !== '/websocket') {
      console.log('Invalid WebSocket path:', pathname);
      socket.destroy();
      return;
    }

    // Handle CORS
    const origin = request.headers.origin || null;
    const allowedOrigins = [
      'http://localhost:3000',
      'https://localhost:3000',
      'https://documents-production.up.railway.app',
      'https://piehost.com',
      'http://piehost.com',
      'https://websocketking.com',
      'https://www.websocketking.com',
      'https://postman.com',
      'https://www.postman.com',
      null // Allow connections with no origin for testing tools
    ];
    
    if (!allowedOrigins.includes(origin)) {
      console.log('Invalid origin:', origin);
      socket.destroy();
      return;
    }

    // Don't send WebSocket headers manually, let the ws library handle it
    try {
      // Complete the WebSocket upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('WebSocket connection upgraded successfully');
        wss.emit('connection', ws, request);
      });
    } catch (error) {
      console.error('Error during WebSocket upgrade:', error);
      socket.destroy();
    }
  });

  // Handle connection timeouts
  wss.on('connection', (ws: WebSocket) => {
    const docWs = ws as DocumentWebSocket;
    docWs.isAlive = true;

    // Set up a per-connection timeout
    const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log('Connection timeout - closing connection');
        ws.close(1000, 'Connection timeout');
      }
    }, 60000); // 60 seconds

    // Clear the timeout when the connection closes
    ws.on('close', () => {
      clearTimeout(connectionTimeout);
    });

    // Reset the timeout on any activity
    ws.on('message', () => {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
    });

    ws.on('pong', () => {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
      }
      docWs.isAlive = true;
    });
  });

  wss.on('close', () => {
    console.log('WebSocket server closing');
  })

  wss.on('error', (error: Error) => {
    console.error('WebSocket server error:', error);
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    console.log('New WebSocket connection attempt');
    
    const docWs = ws as DocumentWebSocket;
    docWs.isAlive = true;

    // Get token and documentId from URL parameters
    const { query } = parseUrl(req.url || '', true);
    console.log('URL Query parameters:', query);
    
    const token = query.token as string;
    const documentId = query.documentId as string;

    if (!token) {
      console.log('No token provided - closing connection');
      ws.close(1008, 'Authentication required');
      return;
    }

    try {
      console.log('Authenticating connection...');
      const userId = await authenticateUser(token);
      console.log('User authenticated:', userId);
      docWs.userId = userId;

      // Send initial connection success message first
      console.log('Sending connection success message');
      try {
        ws.send(JSON.stringify({ 
          type: 'connected',
          userId: userId,
          documentId: documentId || null
        }));
      } catch (error) {
        console.error('Error sending connection success message:', error);
        ws.close(1011, 'Failed to send connection message');
        return;
      }

      // Verify document access if documentId is provided
      if (documentId) {
        console.log('Verifying document access:', documentId);
        const document = await db.document.findFirst({
          where: {
            id: documentId,
            users: {
              some: {
                id: userId
              }
            }
          }
        });

        if (!document) {
          console.log('Document access denied');
          ws.close(1008, 'Document access denied');
          return;
        }

        console.log('Document access verified');
        docWs.documentId = documentId;
      }

      // Set up message handler
      ws.on('message', async (message: RawData) => {
        try {
          const data: DocumentUpdate = JSON.parse(message.toString());
          console.log('Received message:', data.type);
          
          // Ensure the documentId matches if it was provided in URL
          if (docWs.documentId && data.documentId !== docWs.documentId) {
            console.log('Document ID mismatch');
            ws.send(JSON.stringify({ error: 'Document ID mismatch' }));
            return;
          }
          
          switch (data.type) {
            case 'update':
              await handleDocumentUpdate(docWs, data, wss);
              break;
            case 'cursor':
              await handleCursorUpdate(docWs, data, wss);
              break;
            case 'presence':
              await handlePresenceUpdate(docWs, data, wss);
              break;
            default:
              console.log('Unknown message type:', data.type);
              ws.send(JSON.stringify({ error: 'Unknown message type' }));
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
          ws.send(JSON.stringify({ error: 'Invalid message format' }));
        }
      });

      // Set up error handler
      ws.on('error', (error: Error) => {
        console.error('WebSocket connection error:', error);
      });

      // Set up close handler
      ws.on('close', (code: number, reason: string) => {
        console.log(`WebSocket closed - Code: ${code}, Reason: ${reason}`);
        if (docWs.documentId && docWs.userId) {
          broadcastToDocument(wss, docWs.documentId, {
            type: 'presence',
            userId: docWs.userId,
            documentId: docWs.documentId,
            data: { status: 'offline' }
          }, ws);
        }
      });

      // Set up pong handler
      ws.on('pong', () => {
        console.log('Received pong from client');
        docWs.isAlive = true;
      });

      // Send an immediate ping to verify connection
      try {
        ws.ping();
      } catch (error) {
        console.error('Error sending initial ping:', error);
      }

    } catch (error) {
      console.error('Authentication error:', error);
      ws.close(1008, 'Authentication failed');
    }
  });

  return wss;
}

async function handleDocumentUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  // Verify document access
  const document = await db.document.findFirst({
    where: {
      id: data.documentId,
      users: {
        some: {
          id: ws.userId!
        }
      }
    }
  })

  if (!document) {
    (ws as WebSocket).send(JSON.stringify({ error: 'Document access denied' }))
    return
  }

  ws.documentId = data.documentId

  // Update document in database
  await db.document.update({
    where: { id: data.documentId },
    data: {
      content: data.data.content as Prisma.InputJsonValue,
      versions: {
        create: {
          content: data.data.content as Prisma.InputJsonValue,
          user: { connect: { id: ws.userId! } }
        }
      }
    }
  })

  // Broadcast update to other clients
  broadcastToDocument(wss, data.documentId, {
    type: 'update',
    userId: ws.userId!,
    documentId: data.documentId,
    data: data.data
  }, ws)
}

async function handleCursorUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  ws.documentId = data.documentId
  
  // Broadcast cursor position to other clients
  broadcastToDocument(wss, data.documentId, {
    type: 'cursor',
    userId: ws.userId!,
    documentId: data.documentId,
    data: data.data
  }, ws)
}

async function handlePresenceUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  ws.documentId = data.documentId

  // Broadcast presence update to other clients
  broadcastToDocument(wss, data.documentId, {
    type: 'presence',
    userId: ws.userId!,
    documentId: data.documentId,
    data: data.data
  }, ws)
}

function broadcastToDocument(
  wss: WebSocketServer,
  documentId: string,
  data: DocumentUpdate,
  excludeWs?: WebSocket
) {
  wss.clients.forEach((client: WebSocket) => {
    const docClient = client as DocumentWebSocket
    if (
      client !== excludeWs &&
      docClient.documentId === documentId &&
      client.readyState === WebSocket.OPEN
    ) {
      client.send(JSON.stringify(data))
    }
  })
}

