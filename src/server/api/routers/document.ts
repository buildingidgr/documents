import { z } from 'zod'
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../trpc'
import { TRPCError } from '@trpc/server'

export const documentRouter = createTRPCRouter({
  create: protectedProcedure
    .input(z.object({
      title: z.string(),
      content: z.any(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.document.create({
        data: {
          title: input.title,
          content: input.content,
          users: {
            connect: { id: ctx.userId },
          },
          versions: {
            create: {
              content: input.content,
              user: { connect: { id: ctx.userId } },
            },
          },
        },
      });
    }),

  getById: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input }) => {
      const document = await ctx.prisma.document.findUnique({
        where: { id: input },
        include: {
          versions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { user: true },
          },
          users: true,
        },
      });

      if (!document) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      if (!document.users.some(user => user.id === ctx.userId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this document',
        });
      }

      return document;
    }),

  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      content: z.any(),
    }))
    .mutation(async ({ ctx, input }) => {
      const document = await ctx.prisma.document.findUnique({
        where: { id: input.id },
        include: { users: true },
      });

      if (!document) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      if (!document.users.some(user => user.id === ctx.userId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to update this document',
        });
      }

      return ctx.prisma.document.update({
        where: { id: input.id },
        data: {
          content: input.content,
          versions: {
            create: {
              content: input.content,
              user: { connect: { id: ctx.userId } },
            },
          },
        },
        include: {
          versions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { user: true },
          },
        },
      });
    }),

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
  addCollaborator: protectedProcedure
    .input(z.object({
      documentId: z.string(),
      userId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const document = await ctx.prisma.document.findUnique({
        where: { id: input.documentId },
        include: { users: true },
      });

      if (!document) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      if (!document.users.some(user => user.id === ctx.userId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to add collaborators to this document',
        });
      }

      return ctx.prisma.document.update({
        where: { id: input.documentId },
        data: {
          users: {
            connect: { id: input.userId },
          },
        },
      });
    }),

  removeCollaborator: protectedProcedure
    .input(z.object({
      documentId: z.string(),
      userId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const document = await ctx.prisma.document.findUnique({
        where: { id: input.documentId },
        include: { users: true },
      });

      if (!document) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Document not found',
        });
      }

      if (!document.users.some(user => user.id === ctx.userId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to remove collaborators from this document',
        });
      }

      return ctx.prisma.document.update({
        where: { id: input.documentId },
        data: {
          users: {
            disconnect: { id: input.userId },
          },
        },
      });
    }),
})

