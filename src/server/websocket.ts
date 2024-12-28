import WebSocket, { RawData, WebSocketServer } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'http'
import { authenticateUser } from './auth'
import { db } from './db'
import { Prisma } from '@prisma/client'
import { parse as parseUrl } from 'url'

interface DocumentWebSocket extends WebSocket {
  documentId?: string
  userId?: string
  isAlive?: boolean
  // WebSocket readyState values:
  // 0 - CONNECTING
  // 1 - OPEN
  // 2 - CLOSING
  // 3 - CLOSED
  readyState: 0 | 1 | 2 | 3
  on(event: 'close', listener: (this: WebSocket, code: number, reason: Buffer) => void): this
  on(event: 'error', listener: (this: WebSocket, err: Error) => void): this
  on(event: 'upgrade', listener: (this: WebSocket, request: IncomingMessage) => void): this
  on(event: 'message', listener: (this: WebSocket, data: RawData) => void): this
  on(event: 'open', listener: (this: WebSocket) => void): this
  on(event: 'ping', listener: (this: WebSocket, data: Buffer) => void): this
  on(event: 'pong', listener: (this: WebSocket, data: Buffer) => void): this
  on(event: 'unexpected-response', listener: (this: WebSocket, request: IncomingMessage, response: IncomingMessage) => void): this
  on(event: string | symbol, listener: (this: WebSocket, ...args: any[]) => void): this
  ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void
  terminate(): void
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
    noServer: true,
    clientTracking: true,
    perMessageDeflate: {
      zlibDeflateOptions: {
        // See zlib defaults.
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      // Below options specified as default values.
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      // Below options are defaults.
      concurrencyLimit: 10,
      threshold: 1024
    },
    maxPayload: 1024 * 1024 // 1MB max message size
  });

  // Handle upgrade requests
  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    console.log('Upgrade request received');
    
    try {
      // Quick validation of path and origin
      const { pathname } = parseUrl(request.url || '', true);
      if (pathname !== '/ws' && pathname !== '/websocket') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

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
        null
      ];

      if (!allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete upgrade immediately
      wss.handleUpgrade(request, socket, head, async (ws) => {
        const docWs = ws as DocumentWebSocket;
        docWs.isAlive = true;

        // Set up ping interval immediately
        const pingInterval = setInterval(() => {
          if (docWs.readyState === WebSocket.OPEN) {
            try {
              docWs.ping();
            } catch (error) {
              clearInterval(pingInterval);
              docWs.terminate();
            }
          } else {
            clearInterval(pingInterval);
          }
        }, 15000);

        // Set up basic handlers
        docWs.on('close', () => {
          clearInterval(pingInterval);
        });

        docWs.on('pong', () => {
          docWs.isAlive = true;
        });

        // Now authenticate after upgrade
        try {
          const { query } = parseUrl(request.url || '', true);
          const token = query.token as string;
          const documentId = query.documentId as string;

          if (!token) {
            docWs.close(1008, 'Authentication required');
            return;
          }

          const userId = await authenticateUser(token);
          docWs.userId = userId;

          if (documentId) {
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
              docWs.close(1008, 'Document access denied');
              return;
            }

            docWs.documentId = documentId;
          }

          // Send success message
          const successMessage = JSON.stringify({ 
            type: 'connected',
            userId: userId,
            documentId: documentId || null
          });
          docWs.send(successMessage);

          // Set up message handler
          docWs.on('message', async (message: RawData) => {
            try {
              const data: DocumentUpdate = JSON.parse(message.toString());
              
              if (docWs.documentId && data.documentId !== docWs.documentId) {
                docWs.send(JSON.stringify({ error: 'Document ID mismatch' }));
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
                  docWs.send(JSON.stringify({ error: 'Unknown message type' }));
              }
            } catch (error) {
              docWs.send(JSON.stringify({ error: 'Invalid message format' }));
            }
          });

          // Emit connection event
          wss.emit('connection', docWs, request);
        } catch (error) {
          console.error('Authentication error:', error);
          docWs.close(1008, 'Authentication failed');
        }
      });
    } catch (error) {
      console.error('Upgrade error:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
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

