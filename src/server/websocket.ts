import { Server, WebSocket } from 'ws'
import { applyPatch, Operation } from 'rfc6902'
import { prisma } from './db'
import { Prisma } from '@prisma/client'

// Extend the WebSocket type to include our custom property
interface DocumentWebSocket extends WebSocket {
  documentId?: string;
}

interface PatchOperation {
  op: string;
  path: string;
  value?: any;
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
            const updatedContent: Prisma.InputJsonValue = JSON.parse(JSON.stringify(document.content));
            data.operations.forEach((op: PatchOperation) => {
              if (op.op === 'replace' && typeof op.path === 'string') {
                const path = op.path.split('/').filter(Boolean);
                let current: any = updatedContent;
                for (let i = 0; i < path.length - 1; i++) {
                  current = current[path[i]];
                }
                current[path[path.length - 1]] = op.value;
              }
            });
            await prisma.document.update({
              where: { id: data.documentId },
              data: { content: updatedContent as Prisma.InputJsonValue },
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

