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

  const validationUrl = `${authServiceUrl}/v1/token/validate`;
  const requestBody = JSON.stringify({ token });
  console.log('Auth Service Request:', {
    url: validationUrl,
    method: 'POST',
    body: requestBody
  });

  try {
    const response = await fetch(validationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://documents-production.up.railway.app',
        'Accept': 'application/json'
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
    throw new Error('Invalid or expired token');
  }
}

export async function authenticateUser(token?: string): Promise<string> {
  if (!token) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'No authorization token provided',
    });
  }

  try {
    console.log('Validating token:', token.substring(0, 20) + '...');
    
    // Remove 'Bearer ' prefix if present
    const cleanToken = token.replace('Bearer ', '');
    
    const authServiceUrl = process.env.AUTH_SERVICE_URL;
    if (!authServiceUrl) {
      throw new Error('AUTH_SERVICE_URL is not set');
    }

    const response = await fetch(`${authServiceUrl}/v1/token/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://documents-production.up.railway.app',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ token: cleanToken }),
    });

    if (!response.ok) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Token validation failed',
      });
    }

    const data = await response.json();
    console.log('Token validation response:', data);

    if (!data.isValid || !data.userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid token',
      });
    }

    return data.userId;
  } catch (error) {
    console.error('Token validation error:', error);
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Authentication failed',
    });
  }
}

