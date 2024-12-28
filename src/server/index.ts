import { createServer } from 'http';
import { setupWebSocket } from './websocket';

const server = createServer();
const io = setupWebSocket(server);

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

server.listen(process.env.PORT || 8080, () => {
  console.log(`Server listening on port ${process.env.PORT || 8080}`);
}); 