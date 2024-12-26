import { Server, WebSocket } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'http'
import { authenticateUser } from './auth'
import { db } from './db'
import { Prisma } from '@prisma/client'

interface DocumentWebSocket extends WebSocket {
  documentId?: string
  userId?: string
  isAlive: boolean
}

interface DocumentUpdate {
  type: 'update' | 'cursor' | 'presence'
  documentId: string
  userId: string
  data: any
}

export function setupWebSocket(server: HttpServer) {
  const wss = new Server({ server })

  // Heartbeat to keep connections alive and detect stale ones
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const docWs = ws as DocumentWebSocket
      if (!docWs.isAlive) {
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

    // Handle authentication
    const token = req.headers['authorization']?.split(' ')[1]
    try {
      const userId = await authenticateUser(token)
      docWs.userId = userId
    } catch (error) {
      ws.close(1008, 'Authentication failed')
      return
    }

    ws.on('pong', () => {
      docWs.isAlive = true
    })

    ws.on('message', async (message: Buffer) => {
      try {
        const data: DocumentUpdate = JSON.parse(message.toString())
        
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
            ws.send(JSON.stringify({ error: 'Unknown message type' }))
        }
      } catch (error) {
        console.error('WebSocket message error:', error)
        ws.send(JSON.stringify({ error: 'Invalid message format' }))
      }
    })

    ws.on('close', () => {
      // Notify other clients about user leaving
      if (docWs.documentId && docWs.userId) {
        broadcastToDocument(wss, docWs.documentId, {
          type: 'presence',
          userId: docWs.userId,
          documentId: docWs.documentId,
          data: { status: 'offline' }
        }, ws)
      }
    })
  })
}

async function handleDocumentUpdate(
  ws: DocumentWebSocket,
  data: DocumentUpdate,
  wss: Server
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
  wss: Server
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
  wss: Server
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
  wss: Server,
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

