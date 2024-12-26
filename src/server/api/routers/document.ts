import { z } from 'zod'
import { createTRPCRouter, publicProcedure } from '../trpc'
import { TRPCError } from '@trpc/server'

export const documentRouter = createTRPCRouter({
  // Existing procedures...

  addComment: publicProcedure
    .input(z.object({
      documentId: z.string(),
      userId: z.string(),
      content: z.string(),
      position: z.any(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.comment.create({
        data: {
          content: input.content,
          position: input.position,
          document: { connect: { id: input.documentId } },
          user: { connect: { id: input.userId } },
        },
      })
    }),

  getComments: publicProcedure
    .input(z.string())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.comment.findMany({
        where: { documentId: input },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
      })
    }),

  uploadImage: publicProcedure
    .input(z.object({
      documentId: z.string(),
      url: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.image.create({
        data: {
          url: input.url,
          document: { connect: { id: input.documentId } },
        },
      })
    }),

  getImages: publicProcedure
    .input(z.string())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.image.findMany({
        where: { documentId: input },
        orderBy: { createdAt: 'desc' },
      })
    }),
})

