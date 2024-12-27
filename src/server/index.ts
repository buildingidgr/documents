import { createServer } from 'http';
import next from 'next';
import { parse } from 'url';
import { setupWebSocket } from './websocket';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    // Handle WebSocket upgrade requests
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
      console.log('WebSocket upgrade request received');
      return;
    }

    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const wss = setupWebSocket(server);

  // Handle upgrade events explicitly
  server.on('upgrade', (request, socket, head) => {
    const pathname = parse(request.url || '').pathname;
    console.log('Upgrade request received for path:', pathname);

    if (pathname === '/ws' || pathname === '/websocket') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('WebSocket connection upgraded successfully');
        wss.emit('connection', ws, request);
      });
    } else {
      console.log('Invalid WebSocket path, closing connection');
      socket.destroy();
    }
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
}); 