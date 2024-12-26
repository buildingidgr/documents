import { TRPCError } from '@trpc/server';

interface AuthResponse {
  isValid: boolean;
  userId: string;
}

export async function validateToken(token: string): Promise<AuthResponse> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL is not set');
  }

  try {
    const response = await fetch(authServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      throw new Error('Failed to validate token');
    }

    const data: AuthResponse = await response.json();
    return data;
  } catch (error) {
    console.error('Token validation error:', error);
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
  }
}

export async function authenticateUser(token: string | undefined): Promise<string> {
  if (!token) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication token is missing',
    });
  }

  const authResponse = await validateToken(token);

  if (!authResponse.isValid) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
  }

  return authResponse.userId;
}

