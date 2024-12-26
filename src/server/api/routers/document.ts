import { z } from 'zod'
import { createTRPCRouter, protectedProcedure } from '../trpc'
import { TRPCError } from '@trpc/server'

export const documentRouter = createTRPCRouter({
  create: protectedProcedure
    .input(
      z.object({
        title: z.string(),
        content: z.any(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      console.log('Document create procedure called');
      console.log('Input received:', input);
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

        console.log('Document created successfully:', newDocument);
        return newDocument;
      } catch (error) {
        console.error('Error creating document:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create document',
          cause: error,
        });
      }
    }),

  // ... other procedures remain unchanged
});

