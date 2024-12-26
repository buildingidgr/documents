import { Server, WebSocket } from 'ws'
import { applyPatch, Operation } from 'rfc6902'
import { prisma } from './db'

// Extend the WebSocket type to include our custom property
interface DocumentWebSocket extends WebSocket {
  documentId?: string;
}

export function setupWebSocket(server: any) {
  const wss = new Server({ server })

  wss.on('connection', (ws: DocumentWebSocket) => {
    ws.on('message', async (message: string) => {
      const data = JSON.parse(message)

      if (data.type === 'join') {
        // Join a document room
        ws.documentId = data.documentId
      } else if (data.type === 'update') {
        // Apply updates to the document
        const document = await prisma.document.findUnique({
          where: { id: data.documentId },
        })

        if (document) {
          const patchResult = applyPatch(document.content, data.operations);
          if (patchResult.every(result => result === null)) {
            const updatedContent = patchResult.newDocument;
            await prisma.document.update({
              where: { id: data.documentId },
              data: { content: updatedContent as any },
            });
          }

          // Broadcast changes to all clients in the same document room
          wss.clients.forEach((client: DocumentWebSocket) => {
            if (client.documentId === data.documentId && client !== ws) {
              client.send(JSON.stringify({
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

