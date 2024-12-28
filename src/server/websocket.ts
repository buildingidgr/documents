import WebSocket, { RawData, WebSocketServer } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'http'
import { authenticateUser } from './auth'
import { db } from './db'
import { Prisma } from '@prisma/client'
import { parse as parseUrl } from 'url'
import { createHash } from 'crypto'

interface DocumentWebSocket extends WebSocket {
  documentId?: string
  userId?: string
  isAlive?: boolean
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

function getRealIp(request: IncomingMessage): string {
  return (
    request.headers['x-real-ip'] as string ||
    request.headers['x-forwarded-for'] as string ||
    request.socket.remoteAddress ||
    ''
  )
}

function generateAcceptKey(wsKey: string): string {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const combined = wsKey + GUID
  return createHash('sha1').update(combined).digest('base64')
}

function cleanOrigin(origin: string | undefined): string | null {
  if (!origin) return null;

  // Convert to string and trim
  const str = String(origin).trim();

  // Remove any trailing semicolons, commas, quotes and whitespace
  return str
    .replace(/[;,'"]+/g, '')  // Remove all semicolons, commas and quotes
    .trim();  // Remove any remaining whitespace
}

async function handleConnection(docWs: DocumentWebSocket, request: IncomingMessage, wss: WebSocketServer) {
  let socketClosed = false
  docWs.isAlive = true

  // Set up heartbeat immediately
  const pingInterval = setInterval(() => {
    if (!docWs.isAlive) {
      console.log('Connection dead, terminating', { userId: docWs.userId })
      clearInterval(pingInterval)
      return docWs.terminate()
    }
    docWs.isAlive = false
    try {
      docWs.ping()
    } catch (err) {
      console.error('Ping error:', err, { userId: docWs.userId })
      clearInterval(pingInterval)
      docWs.terminate()
    }
  }, 30000)

  // Set up basic handlers
  docWs.on('pong', () => {
    docWs.isAlive = true
    console.log('Received pong from client', { userId: docWs.userId })
  })

  docWs.on('error', (error) => {
    console.error('WebSocket error:', error, { userId: docWs.userId })
    socketClosed = true
    clearInterval(pingInterval)
  })

  docWs.on('close', (code, reason) => {
    console.log(`Connection closed with code ${code}:`, reason.toString(), { userId: docWs.userId })
    socketClosed = true
    clearInterval(pingInterval)
  })

  try {
    const { query } = parseUrl(request.url || '', true)
    const documentId = query.documentId as string

    // Document access check (if documentId provided)
    if (documentId) {
      const document = await db.document.findFirst({
        where: {
          id: documentId,
          users: {
            some: {
              id: docWs.userId!
            }
          }
        }
      })

      if (!document) {
        console.log('Document access denied:', documentId, { userId: docWs.userId })
        docWs.close(1008, 'Document access denied')
        return
      }

      docWs.documentId = documentId
      console.log('Document access granted for document:', documentId, { userId: docWs.userId })
    }

    // Send success message immediately if socket is still open
    if (!socketClosed && docWs.readyState === WebSocket.OPEN) {
      const successMessage = JSON.stringify({
        type: 'connected',
        userId: docWs.userId,
        documentId: documentId || null
      })
      
      try {
        docWs.send(successMessage)
        console.log('Success message sent to user:', docWs.userId)
      } catch (error) {
        console.log('Failed to send success message:', error, { userId: docWs.userId })
        return
      }
    }

    // Set up message handler
    setupMessageHandler(docWs, wss)

  } catch (error) {
    console.error('Connection handling error:', error, { userId: docWs.userId })
    docWs.close(1011, 'Internal server error')
  }
}

function setupMessageHandler(docWs: DocumentWebSocket, wss: WebSocketServer) {
  docWs.on('message', async (message: RawData) => {
    try {
      const data: DocumentUpdate = JSON.parse(message.toString())
      console.log('Received message of type:', data.type, { userId: docWs.userId })

      if (docWs.documentId && data.documentId !== docWs.documentId) {
        console.log('Document ID mismatch:', { 
          expected: docWs.documentId, 
          received: data.documentId,
          userId: docWs.userId 
        })
        docWs.send(JSON.stringify({ error: 'Document ID mismatch' }))
        return
      }

      switch (data.type) {
        case 'update':
          await handleDocumentUpdate(docWs, data, wss)
          break
        case 'cursor':
          await handleCursorUpdate(docWs, data, wss)
          break
        case 'presence':
          await handlePresenceUpdate(docWs, data, wss)
          break
        default:
          console.log('Unknown message type:', data.type, { userId: docWs.userId })
          docWs.send(JSON.stringify({ error: 'Unknown message type' }))
      }
    } catch (error) {
      console.error('Message handling error:', error, { userId: docWs.userId })
      docWs.send(JSON.stringify({ error: 'Invalid message format' }))
    }
  })
}

async function handleDocumentUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  try {
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
      console.log('Document update access denied:', data.documentId, { userId: ws.userId })
      ws.send(JSON.stringify({ error: 'Document access denied' }))
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

    console.log('Document updated successfully:', data.documentId, { userId: ws.userId })

    // Broadcast update to other clients
    broadcastToDocument(wss, data.documentId, {
      type: 'update',
      userId: ws.userId!,
      documentId: data.documentId,
      data: data.data
    }, ws)
  } catch (error) {
    console.error('Document update error:', error, { userId: ws.userId })
    ws.send(JSON.stringify({ error: 'Failed to update document' }))
  }
}

async function handleCursorUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  try {
    // Broadcast cursor position to other clients
    broadcastToDocument(wss, data.documentId, {
      type: 'cursor',
      userId: ws.userId!,
      documentId: data.documentId,
      data: data.data
    }, ws)
  } catch (error) {
    console.error('Cursor update error:', error, { userId: ws.userId })
  }
}

async function handlePresenceUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: WebSocketServer
) {
  try {
    // Broadcast presence update to other clients
    broadcastToDocument(wss, data.documentId, {
      type: 'presence',
      userId: ws.userId!,
      documentId: data.documentId,
      data: data.data
    }, ws)
  } catch (error) {
    console.error('Presence update error:', error, { userId: ws.userId })
  }
}

function broadcastToDocument(
  wss: WebSocketServer,
  documentId: string,
  data: DocumentUpdate,
  excludeWs?: WebSocket
) {
  try {
    let broadcastCount = 0
    wss.clients.forEach((client: WebSocket) => {
      const docClient = client as DocumentWebSocket
      if (
        client !== excludeWs &&
        docClient.documentId === documentId &&
        client.readyState === WebSocket.OPEN
      ) {
        try {
          client.send(JSON.stringify(data))
          broadcastCount++
        } catch (error) {
          console.error('Failed to send to a client:', error, { userId: docClient.userId })
        }
      }
    })
    console.log(`Broadcast complete: ${broadcastCount} clients received the update`, {
      documentId,
      userId: (excludeWs as DocumentWebSocket)?.userId
    })
  } catch (error) {
    console.error('Broadcast error:', error)
  }
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up WebSocket server...');

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false, // Disable compression for simpler setup
    maxPayload: 1024 * 1024 // 1MB max message size
  });

  // Handle connection errors at the server level
  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    console.log('Upgrade request received');

    // Handle socket errors
    socket.on('error', (error) => {
      console.error('Socket error:', error);
      socket.destroy();
    });

    try {
      // Basic validation
      if (request.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Parse URL
      const { pathname, query } = parseUrl(request.url || '', true);
      if (pathname !== '/ws' && pathname !== '/websocket') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Get token
      const token = query.token as string;
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Authenticate user before upgrade
      let userId: string;
      try {
        userId = await authenticateUser(token);
        console.log('User authenticated:', userId);
      } catch (error) {
        console.error('Authentication failed:', error);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Complete the upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        const docWs = ws as DocumentWebSocket;
        docWs.userId = userId;
        docWs.isAlive = true;

        // Set up ping interval
        const pingInterval = setInterval(() => {
          if (!docWs.isAlive) {
            console.log('Connection dead, terminating');
            clearInterval(pingInterval);
            return docWs.terminate();
          }
          docWs.isAlive = false;
          try {
            docWs.ping();
          } catch (err) {
            console.error('Ping error:', err);
            clearInterval(pingInterval);
            docWs.terminate();
          }
        }, 30000);

        // Set up handlers
        docWs.on('pong', () => {
          docWs.isAlive = true;
        });

        docWs.on('close', () => {
          console.log('Connection closed');
          clearInterval(pingInterval);
        });

        docWs.on('error', (error) => {
          console.error('WebSocket error:', error);
          clearInterval(pingInterval);
        });

        // Handle document setup after connection is established
        (async () => {
          try {
            const documentId = query.documentId as string;
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
            setupMessageHandler(docWs, wss);

            // Emit connection event
            wss.emit('connection', docWs, request);
          } catch (error) {
            console.error('Document setup error:', error);
            docWs.close(1011, 'Setup failed');
          }
        })();
      });
    } catch (error) {
      console.error('Upgrade error:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}