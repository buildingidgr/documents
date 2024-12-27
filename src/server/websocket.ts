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
    server,
    path: undefined,
    clientTracking: true,
    perMessageDeflate: false, // Disable compression
    maxPayload: 1024 * 1024, // 1MB max message size
    verifyClient: async (info, callback) => {
      console.log('Verifying client connection...');
      console.log('Connection URL:', info.req.url);
      console.log('Headers:', info.req.headers);
      
      const { pathname } = parseUrl(info.req.url || '');
      if (pathname !== '/ws' && pathname !== '/websocket') {
        console.log('Invalid WebSocket path:', pathname);
        callback(false, 400, 'Invalid WebSocket path');
        return;
      }

      // Allow connections from localhost during development
      const origin = info.req.headers.origin;
      const allowedOrigins = [
        'http://localhost:3000',
        'https://localhost:3000',
        'https://documents-production.up.railway.app'
      ];
      
      if (!origin || !allowedOrigins.includes(origin)) {
        console.log('Invalid origin:', origin);
        callback(false, 403, 'Origin not allowed');
        return;
      }

      callback(true);
    }
  });

  console.log('WebSocket server created');

  // Shorter heartbeat interval for Railway
  const heartbeat = setInterval(() => {
    console.log(`Heartbeat check - Active connections: ${wss.clients.size}`);
    wss.clients.forEach((ws: WebSocket) => {
      const docWs = ws as DocumentWebSocket
      if (docWs.isAlive === false) {
        console.log('Terminating inactive connection');
        ws.terminate()
        return
      }
      docWs.isAlive = false
      try {
        ws.ping()
      } catch (error) {
        console.error('Error sending ping:', error);
        ws.terminate();
      }
    })
  }, 15000) // 15 seconds

  wss.on('close', () => {
    console.log('WebSocket server closing');
    clearInterval(heartbeat)
  })

  wss.on('error', (error: Error) => {
    console.error('WebSocket server error:', error);
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    console.log('New WebSocket connection attempt');
    console.log('Connection URL:', req.url);
    console.log('Client IP:', req.socket.remoteAddress);
    console.log('Headers:', req.headers);
    
    const docWs = ws as DocumentWebSocket
    docWs.isAlive = true

    // Get token and documentId from URL parameters
    const { query } = parseUrl(req.url || '', true)
    console.log('URL Query parameters:', query);
    
    const token = query.token as string
    const documentId = query.documentId as string

    if (!token) {
      console.log('No token provided - closing connection');
      ws.close(1008, 'Authentication required')
      return
    }

    try {
      console.log('Authenticating connection...');
      const userId = await authenticateUser(token)
      console.log('User authenticated:', userId);
      docWs.userId = userId

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
        })

        if (!document) {
          console.log('Document access denied');
          ws.close(1008, 'Document access denied')
          return
        }

        console.log('Document access verified');
        docWs.documentId = documentId
      }

      // Set up error handling first
      ws.on('error', (error: Error) => {
        console.error('WebSocket connection error:', error);
      });

      // Set up pong handler
      ws.on('pong', () => {
        console.log('Received pong from client');
        docWs.isAlive = true
      });

      // Send an immediate ping to verify connection
      try {
        ws.ping();
      } catch (error) {
        console.error('Error sending initial ping:', error);
      }

      ws.on('message', (message: RawData) => {
        try {
          const data: DocumentUpdate = JSON.parse(message.toString())
          console.log('Received message:', data.type);
          
          // Ensure the documentId matches if it was provided in URL
          if (docWs.documentId && data.documentId !== docWs.documentId) {
            console.log('Document ID mismatch');
            ws.send(JSON.stringify({ error: 'Document ID mismatch' }))
            return
          }
          
          switch (data.type) {
            case 'update':
              handleDocumentUpdate(docWs, data, wss)
                .catch(error => {
                  console.error('Document update error:', error)
                  ws.send(JSON.stringify({ error: 'Failed to update document' }))
                })
              break
            case 'cursor':
              handleCursorUpdate(docWs, data, wss)
                .catch(error => {
                  console.error('Cursor update error:', error)
                  ws.send(JSON.stringify({ error: 'Failed to update cursor' }))
                })
              break
            case 'presence':
              handlePresenceUpdate(docWs, data, wss)
                .catch(error => {
                  console.error('Presence update error:', error)
                  ws.send(JSON.stringify({ error: 'Failed to update presence' }))
                })
              break
            default:
              console.log('Unknown message type:', data.type);
              ws.send(JSON.stringify({ error: 'Unknown message type' }))
          }
        } catch (error) {
          console.error('WebSocket message error:', error)
          ws.send(JSON.stringify({ error: 'Invalid message format' }))
        }
      })

      ws.on('close', (code: number, reason: string) => {
        console.log(`WebSocket closed - Code: ${code}, Reason: ${reason}`);
        if (docWs.documentId && docWs.userId) {
          broadcastToDocument(wss, docWs.documentId, {
            type: 'presence',
            userId: docWs.userId,
            documentId: docWs.documentId,
            data: { status: 'offline' }
          }, ws)
        }
      })

      // Send initial connection success message
      console.log('Sending connection success message');
      try {
        ws.send(JSON.stringify({ 
          type: 'connected',
          userId: userId,
          documentId: docWs.documentId
        }))
      } catch (error) {
        console.error('Error sending connection success message:', error);
        ws.close(1011, 'Failed to send connection message');
        return;
      }

    } catch (error) {
      console.error('Authentication error:', error)
      ws.close(1008, 'Authentication failed')
    }
  })

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

