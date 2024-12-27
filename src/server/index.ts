import { createServer } from 'http';
import next from 'next';
import { parse } from 'url';
import { setupWebSocket } from './websocket';

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // Handle CORS for WebSocket upgrade requests
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      const origin = req.headers.origin;
      const allowedOrigins = [
        'http://localhost:3000',
        'https://localhost:3000',
        'https://documents-production.up.railway.app',
        'https://piehost.com',
        'http://piehost.com'
      ];

      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }

      return;
    }

    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // Set up WebSocket server
  setupWebSocket(server);

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
}); 