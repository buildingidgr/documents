import { initTRPC, TRPCError } from '@trpc/server';
import { type CreateNextContextOptions } from '@trpc/server/adapters/next';
import superjson from 'superjson';
import { ZodError } from 'zod';
import prisma from '../db';
import { authenticateUser } from '../auth';

export const createTRPCContext = async (opts: CreateNextContextOptions) => {
  const { req, res } = opts;
  const token = req.headers.authorization?.split(' ')[1];

  console.log('Creating tRPC context');
  console.log('Authorization token:', token ? 'Present' : 'Missing');

  let userId: string | null = null;
  try {
    userId = await authenticateUser(token);
    console.log('User authenticated, userId:', userId);
  } catch (error) {
    console.error('Authentication error:', error);
  }

  return {
    prisma,
    userId,
    req,
    res,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
    },
  });
});

