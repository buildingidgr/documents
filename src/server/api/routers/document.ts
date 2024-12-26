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

  // ... other procedures remain unchanged
});

