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
  const wss = new WebSocketServer({ server })

  // Heartbeat to keep connections alive and detect stale ones
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const docWs = ws as DocumentWebSocket
      if (docWs.isAlive === false) {
        ws.terminate()
        return
      }
      docWs.isAlive = false
      ws.ping()
    })
  }, 30000)

  wss.on('close', () => {
    clearInterval(heartbeat)
  })

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const docWs = ws as DocumentWebSocket
    docWs.isAlive = true

    // Get token from URL parameters
    const { query } = parseUrl(req.url || '', true)
    const token = query.token as string

    if (!token) {
      ws.close(1008, 'Authentication required')
      return
    }

    try {
      const userId = await authenticateUser(token)
      docWs.userId = userId

      ws.on('pong', () => {
        docWs.isAlive = true
      })

      ws.on('message', (message: RawData) => {
        try {
          const data: DocumentUpdate = JSON.parse(message.toString())
          
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
              ws.send(JSON.stringify({ error: 'Unknown message type' }))
          }
        } catch (error) {
          console.error('WebSocket message error:', error)
          ws.send(JSON.stringify({ error: 'Invalid message format' }))
        }
      })

      ws.on('close', () => {
        if (docWs.documentId && docWs.userId) {
          broadcastToDocument(wss, docWs.documentId, {
            type: 'presence',
            userId: docWs.userId,
            documentId: docWs.documentId,
            data: { status: 'offline' }
          }, ws)
        }
      })
    } catch (error) {
      console.error('Authentication error:', error)
      ws.close(1008, 'Authentication failed')
    }
  })
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

