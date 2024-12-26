import { createNextApiHandler } from '@trpc/server/adapters/next'
import { appRouter } from '../../../server/api/root'
import { createTRPCContext } from '../../../server/api/trpc'
import { setupWebSocket } from '../../../server/websocket'

const handler = createNextApiHandler({
  router: appRouter,
  createContext: createTRPCContext,
})

export default function (req, res) {
  // Setup WebSocket when the server starts
  if (!res.socket.server.ws) {
    setupWebSocket(res.socket.server)
    res.socket.server.ws = true
  }

  return handler(req, res)
}

