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

  const requestBody = JSON.stringify({ token });
  console.log('Auth Service Request:', {
    url: authServiceUrl,
    method: 'POST',
    body: requestBody
  });

  try {
    const response = await fetch(authServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody,
    });

    const responseData = await response.json();
    console.log('Auth Service Response:', {
      status: response.status,
      body: responseData
    });

    if (!response.ok) {
      throw new Error(`Failed to validate token: ${response.statusText}`);
    }

    return responseData as AuthResponse;
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

