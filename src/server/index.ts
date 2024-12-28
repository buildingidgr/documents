import { createServer } from 'http';
import express, { Request, Response, NextFunction } from 'express';
import { setupWebSocket } from './websocket';

const app = express();
const server = createServer(app);
const io = setupWebSocket(server);

// Add CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Add health check endpoint
app.get('/api/healthcheck', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

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

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Export for Next.js API routes
export default app; 