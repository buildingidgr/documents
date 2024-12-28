import { createServer } from 'http';
import express, { Request, Response } from 'express';
import { setupWebSocket } from './websocket';

const app = express();
const server = createServer(app);
const io = setupWebSocket(server);

// Add CORS middleware
app.use((req, res, next) => {
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
server.on('error', (error) => {
  console.error('Server error:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Export for Next.js API routes
export default app; 