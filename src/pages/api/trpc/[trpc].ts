import { createNextApiHandler } from '@trpc/server/adapters/next'
import { appRouter } from '../../../server/api/root'
import { createTRPCContext } from '../../../server/api/trpc'
import { db } from '../../../server/db'

const handler = createNextApiHandler({
  router: appRouter,
  createContext: createTRPCContext,
  onError:
    process.env.NODE_ENV === 'development'
      ? ({ path, error }) => {
          console.error(`❌ tRPC failed on ${path ?? '<no-path>'}: ${error.message}`)
        }
      : undefined,
})

export default async function (req, res) {
  // Log each API request
  console.log(`API request: ${req.method} ${req.url}`)

  return handler(req, res)
}

