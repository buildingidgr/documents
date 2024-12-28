import express from 'express';
import { createServer } from 'http';
import { setupWebSocket } from './websocket';

const app = express();
const server = createServer(app);

// WebSocket health check endpoint
app.get('/api/ws-health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Handle regular HTTP requests for the websocket path
app.get('/ws', (req, res) => {
  if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() !== 'websocket') {
    res.status(426).send('Upgrade Required');
    return;
  }
  res.status(101).end();
});

const wss = setupWebSocket(server);

// Keep track of WebSocket connection stats
let totalConnections = 0;
let activeConnections = 0;

wss.on('connection', () => {
  totalConnections++;
  activeConnections++;
});

wss.on('close', () => {
  activeConnections--;
});

// Add stats endpoint
app.get('/api/ws-stats', (req, res) => {
  res.json({
    totalConnections,
    activeConnections,
    status: 'ok'
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

export { app, server };