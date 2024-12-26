import { createTRPCRouter } from './trpc'
import { documentRouter } from './routers/document'

export const appRouter = createTRPCRouter({
  document: documentRouter,
})

export type AppRouter = typeof appRouter

