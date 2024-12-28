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

function generateAcceptValue(secWebSocketKey: string): string {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const combined = secWebSocketKey + GUID
  const sha1 = createHash('sha1')
  sha1.update(combined)
  return sha1.digest('base64')
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up WebSocket server...')

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024
    },
    maxPayload: 1024 * 1024 // 1MB max message size
  })

  // Handle upgrade requests
  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    console.log('Upgrade request received')
    console.log('Request headers:', request.headers)

    socket.on('error', (err) => {
      console.error('Socket error during upgrade:', err)
      socket.destroy()
    })

    try {
      // Clean path check
      const { pathname } = parseUrl(request.url || '', true)
      const normalizedPath = pathname?.toLowerCase()
      console.log('Requested path:', normalizedPath)
      
      if (normalizedPath !== '/ws' && normalizedPath !== '/websocket') {
        console.log('Invalid path:', normalizedPath)
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      // Validate WebSocket version
      const version = request.headers['sec-websocket-version']
      if (version !== '13') {
        socket.write('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\n\r\n')
        socket.destroy()
        return
      }

      // Validate WebSocket key
      const key = request.headers['sec-websocket-key']
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      // Clean origin check
      const rawOrigin = request.headers.origin
      const cleanOrigin = rawOrigin?.replace(/[;,]$/, '') || null
      console.log('Clean origin:', cleanOrigin)

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
      ]

      if (!allowedOrigins.includes(cleanOrigin)) {
        console.log('Invalid origin:', cleanOrigin)
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }

      // Extract and validate token
      const { query } = parseUrl(request.url || '', true)
      const token = query.token as string

      if (!token) {
        console.log('No token provided')
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      // Authenticate first
      const userId = await authenticateUser(token)
      if (!userId) {
        console.log('Authentication failed')
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      console.log('Authentication successful for user:', userId)

      // Write upgrade headers
      const acceptValue = generateAcceptValue(key)
      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '',
        ''
      ].join('\r\n')

      // Write the response headers to the socket
      socket.write(headers)

      // Complete upgrade with authenticated user
      wss.handleUpgrade(request, socket, head, (ws) => {
        const docWs = ws as DocumentWebSocket
        docWs.userId = userId
        console.log('WebSocket connection established for user:', userId)
        handleConnection(docWs, request, wss)
      })

    } catch (error) {
      console.error('Upgrade/auth error:', error)
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })

  return wss
}

async function handleConnection(docWs: DocumentWebSocket, request: IncomingMessage, wss: WebSocketServer) {
  let socketClosed = false
  docWs.isAlive = true

  // Set up heartbeat immediately
  const pingInterval = setInterval(() => {
    if (!docWs.isAlive) {
      console.log('Connection dead, terminating')
      clearInterval(pingInterval)
      return docWs.terminate()
    }
    docWs.isAlive = false
    try {
      docWs.ping()
    } catch (err) {
      console.error('Ping error:', err)
      clearInterval(pingInterval)
      docWs.terminate()
    }
  }, 30000)

  // Set up basic handlers
  docWs.on('pong', () => {
    docWs.isAlive = true
  })

  docWs.on('error', (error) => {
    console.error('WebSocket error:', error)
    socketClosed = true
    clearInterval(pingInterval)
  })

  docWs.on('close', (code, reason) => {
    console.log(`Connection closed with code ${code}:`, reason.toString())
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
        console.log('Document access denied:', documentId)
        docWs.close(1008, 'Document access denied')
        return
      }

      docWs.documentId = documentId
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
        console.log('Failed to send success message:', error)
        return
      }
    }

    // Set up message handler
    setupMessageHandler(docWs, wss)

  } catch (error) {
    console.error('Connection handling error:', error)
    docWs.close(1011, 'Internal server error')
  }
}

function setupMessageHandler(docWs: DocumentWebSocket, wss: WebSocketServer) {
  docWs.on('message', async (message: RawData) => {
    try {
      const data: DocumentUpdate = JSON.parse(message.toString())

      if (docWs.documentId && data.documentId !== docWs.documentId) {
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
          docWs.send(JSON.stringify({ error: 'Unknown message type' }))
      }
    } catch (error) {
      console.error('Message handling error:', error)
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

    // Broadcast update to other clients
    broadcastToDocument(wss, data.documentId, {
      type: 'update',
      userId: ws.userId!,
      documentId: data.documentId,
      data: data.data
    }, ws)
  } catch (error) {
    console.error('Document update error:', error)
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
    console.error('Cursor update error:', error)
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
    console.error('Presence update error:', error)
  }
}

function broadcastToDocument(
  wss: WebSocketServer,
  documentId: string,
  data: DocumentUpdate,
  excludeWs?: WebSocket
) {
  try {
    wss.clients.forEach((client: WebSocket) => {
      const docClient = client as DocumentWebSocket
      if (
        client !== excludeWs &&
        docClient.documentId === documentId &&
        client.readyState === WebSocket.OPEN
      ) {
        try {
          client.send(JSON.stringify(data))
        } catch (error) {
          console.error('Failed to send to a client:', error)
        }
      }
    })
  } catch (error) {
    console.error('Broadcast error:', error)
  }
}