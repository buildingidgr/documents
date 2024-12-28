import WebSocket, { RawData, WebSocketServer } from 'ws'
import { Server as HttpServer, IncomingMessage } from 'http'
import { authenticateUser } from './auth'
import { db } from './db'
import { Prisma } from '@prisma/client'
import { parse as parseUrl } from 'url'
import { createHash } from 'crypto'

interface DocumentWebSocket extends WebSocket {
  documentId?: string
  userId?: string
  isAlive?: boolean
  readyState: 0 | 1 | 2 | 3
  on(event: 'close', listener: (this: WebSocket, code: number, reason: Buffer) => void): this
  on(event: 'error', listener: (this: WebSocket, err: Error) => void): this
  on(event: 'upgrade', listener: (this: WebSocket, request: IncomingMessage) => void): this
  on(event: 'message', listener: (this: WebSocket, data: RawData) => void): this
  on(event: 'open', listener: (this: WebSocket) => void): this
  on(event: 'ping', listener: (this: WebSocket, data: Buffer) => void): this
  on(event: 'pong', listener: (this: WebSocket, data: Buffer) => void): this
  on(event: 'unexpected-response', listener: (this: WebSocket, request: IncomingMessage, response: IncomingMessage) => void): this
  on(event: string | symbol, listener: (this: WebSocket, ...args: any[]) => void): this
  ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void
  terminate(): void
}

interface DocumentUpdate {
  type: 'update' | 'cursor' | 'presence'
  documentId: string
  userId: string
  data: any
}

function getRealIp(request: IncomingMessage): string {
  return (
    request.headers['x-real-ip'] as string ||
    request.headers['x-forwarded-for'] as string ||
    request.socket.remoteAddress ||
    ''
  )
}

function generateAcceptKey(wsKey: string): string {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const combined = wsKey + GUID
  return createHash('sha1').update(combined).digest('base64')
}

export function setupWebSocket(server: HttpServer) {
  console.log('Setting up WebSocket server...')

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 1024
    },
    maxPayload: 1024 * 1024
  })

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    console.log('Upgrade request received')
    console.log('Request headers:', request.headers)
    
    const clientIp = getRealIp(request)
    console.log('Client IP:', clientIp)

    socket.on('error', (err) => {
      console.error('Socket error during upgrade:', err)
      socket.destroy()
    })

    try {
      // Verify it's a WebSocket upgrade
      if (
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !request.headers['sec-websocket-key'] ||
        !request.headers['sec-websocket-version']
      ) {
        console.log('Not a valid WebSocket upgrade request')
        socket.write('HTTP/1.1 426 Upgrade Required\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    'Sec-WebSocket-Version: 13\r\n\r\n')
        socket.destroy()
        return
      }

      // Clean path check
      const { pathname } = parseUrl(request.url || '', true)
      const normalizedPath = pathname?.toLowerCase()
      console.log('Requested path:', normalizedPath)
      
      if (normalizedPath !== '/ws' && normalizedPath !== '/websocket') {
        console.log('Invalid path:', normalizedPath)
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      // Extract and validate token
      const { query } = parseUrl(request.url || '', true)
      const token = query.token as string

      if (!token) {
        console.log('No token provided')
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      // Authenticate first
      const userId = await authenticateUser(token)
      if (!userId) {
        console.log('Authentication failed')
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      console.log('Authentication successful for user:', userId)

      // Generate accept key
      const key = request.headers['sec-websocket-key']
      const acceptKey = generateAcceptKey(key!)

      // Send WebSocket upgrade response
      const upgradeResponse = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        ''
      ].join('\r\n')

      socket.write(upgradeResponse)

      // Complete upgrade with authenticated user
      wss.handleUpgrade(request, socket, head, (ws) => {
        const docWs = ws as DocumentWebSocket
        docWs.userId = userId
        console.log('WebSocket connection established for user:', userId)
        handleConnection(docWs, request, wss)
      })

    } catch (error) {
      console.error('Upgrade/auth error:', error)
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })

  return wss
}

// Rest of the file stays the same as before
[... handleConnection, setupMessageHandler, handleDocumentUpdate, etc. ...]