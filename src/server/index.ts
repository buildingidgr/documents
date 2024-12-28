import { createServer } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { setupWebSocket } from './websocket';

const app = express();
const server = createServer(app);

// Add CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

// Add health check endpoint
app.get('/api/healthcheck', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  const upgradeHeader = request.headers['upgrade'];
  if (upgradeHeader !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  console.log('WebSocket upgrade request received');
});

// Initialize Socket.IO after setting up upgrade handler
const io = setupWebSocket(server);

// Add error handlers
server.on('error', (err: Error) => {
  console.error('Server error:', err);
});

process.on('uncaughtException', (err: Error) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err: Error | null) => {
  console.error('Unhandled rejection:', err);
});

// Add before other middleware in src/server/index.ts
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    headers: req.headers,
    query: req.query
  });
  next();
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(`WebSocket server ready at ws://localhost:${port}/ws`);
});

// Export for Next.js API routes
export default app; 