import { z } from 'zod'
import { createTRPCRouter, protectedProcedure } from '../trpc'
import { TRPCError } from '@trpc/server'
import { Prisma } from '@prisma/client'

const documentInputSchema = z.object({
  title: z.string(),
  content: z.any(),
})

export const documentRouter = createTRPCRouter({
  create: protectedProcedure
    .input(documentInputSchema)
    .mutation(async ({ ctx, input }) => {
      console.log('Document create procedure called');
      console.log('Input received:', JSON.stringify(input, null, 2));
      console.log('Current user:', ctx.userId);

      if (!input || !input.title || !input.content) {
        console.error('Invalid input:', input);
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid input: title and content are required',
        });
      }

      try {
        const newDocument = await ctx.prisma.document.create({
          data: {
            title: input.title,
            content: input.content as Prisma.InputJsonValue,
            users: {
              connect: { id: ctx.userId },
            },
            versions: {
              create: {
                content: input.content as Prisma.InputJsonValue,
                user: { connect: { id: ctx.userId } },
              },
            },
          },
        });

        console.log('Document created successfully:', JSON.stringify(newDocument, null, 2));
        return newDocument;
      } catch (error) {
        console.error('Error creating document:', error);
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to create document: ${error.message}`,
            cause: error,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred while creating the document',
          cause: error,
        });
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      console.log('Document delete procedure called');
      console.log('Document ID:', input.id);
      console.log('Current user:', ctx.userId);

      try {
        // First check if the user has access to this document
        const document = await ctx.prisma.document.findFirst({
          where: {
            id: input.id,
            users: {
              some: {
                id: ctx.userId
              }
            }
          }
        });

        if (!document) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Document not found or you do not have permission to delete it',
          });
        }

        // Delete the document and all related versions
        await ctx.prisma.document.delete({
          where: {
            id: input.id,
          },
        });

        console.log('Document deleted successfully:', input.id);
        return { success: true, id: input.id };
      } catch (error) {
        console.error('Error deleting document:', error);
        if (error instanceof TRPCError) {
          throw error;
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to delete document: ${error.message}`,
            cause: error,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred while deleting the document',
          cause: error,
        });
      }
    }),

  // ... other procedures remain unchanged
});

