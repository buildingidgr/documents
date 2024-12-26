import { Server } from 'ws'
import { applyPatch } from 'rfc6902'
import { prisma } from './db'

interface DocumentWebSocket extends WebSocket {
  documentId?: string;
}

export function setupWebSocket(server: any) {
  const wss = new Server({ server })

  wss.on('connection', (ws: WebSocket) => {
    const documentWs = ws as DocumentWebSocket;
    documentWs.on('message', async (message: string) => {
      const data = JSON.parse(message)

      if (data.type === 'join') {
        documentWs.documentId = data.documentId
      } else if (data.type === 'update') {
        const document = await prisma.document.findUnique({
          where: { id: data.documentId },
        })

        if (document) {
          const updatedContent = applyPatch(document.content, data.operations).newDocument
          await prisma.document.update({
            where: { id: data.documentId },
            data: { content: updatedContent },
          })

          wss.clients.forEach((client: WebSocket) => {
            const docClient = client as DocumentWebSocket;
            if (docClient.documentId === data.documentId && docClient !== documentWs) {
              docClient.send(JSON.stringify({
                type: 'update',
                operations: data.operations,
              }))
            }
          })
        }
      }
    })
  })
}

