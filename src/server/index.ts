import { createServer } from 'http';
import express from 'express';
import { setupWebSocket } from './websocket';

const app = express();
const server = createServer(app);
const io = setupWebSocket(server);

// Add health check endpoint
app.get('/api/healthcheck', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  console.log('Upgrade request received');
  
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    socket.write('HTTP/1.1 204 No Content\r\n' +
                'Connection: keep-alive\r\n' +
                'Access-Control-Allow-Origin: *\r\n' +
                'Access-Control-Allow-Methods: GET, POST\r\n' +
                'Access-Control-Allow-Headers: Authorization, Content-Type\r\n' +
                'Access-Control-Max-Age: 86400\r\n' +
                '\r\n');
    socket.destroy();
    return;
  }
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