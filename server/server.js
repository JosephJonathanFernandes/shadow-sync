'use strict';

const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB
const HEARTBEAT_INTERVAL_MS = 30_000;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

const rooms = new Map();

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId);
}

function sendJson(client, data) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(data));
  }
}

function broadcastPeerCount(roomId) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const count = clients.size;
  for (const client of clients) {
    sendJson(client, { type: 'peer_count', roomId, count });
  }
}

function leaveCurrentRoom(ws) {
  const roomId = ws.currentRoom;
  if (!roomId) return;

  const clients = rooms.get(roomId);
  if (clients) {
    clients.delete(ws);
    console.log(`[-] Client left room: ${roomId} (${clients.size} remaining)`);
    if (clients.size === 0) {
      rooms.delete(roomId);
      console.log(`[!] Room ${roomId} is empty and has been destroyed.`);
    } else {
      broadcastPeerCount(roomId);
    }
  }
  ws.currentRoom = null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        clients: wss.clients.size,
      }),
    );
    return;
  }

  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Shadow-Sync Relay Server — Upgrade to WebSocket required');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.currentRoom = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      sendJson(ws, { type: 'error', message: 'Invalid message format' });
      return;
    }

    const { type, roomId, payload, timestamp } = parsed;
    if (!isValidRoomId(roomId)) {
      sendJson(ws, { type: 'error', message: 'Invalid roomId' });
      return;
    }

    if (type === 'join') {
      if (ws.currentRoom && ws.currentRoom !== roomId) {
        leaveCurrentRoom(ws);
      }
      ws.currentRoom = roomId;
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      rooms.get(roomId).add(ws);
      console.log(`[+] Client joined room: ${roomId} (${rooms.get(roomId).size} online)`);
      broadcastPeerCount(roomId);
      return;
    }

    if (!ws.currentRoom || ws.currentRoom !== roomId) {
      sendJson(ws, { type: 'error', message: 'Must join room before sending messages' });
      return;
    }

    const clients = rooms.get(ws.currentRoom);
    if (!clients) return;

    if (type === 'sync') {
      if (typeof payload !== 'string' || payload.length === 0) {
        sendJson(ws, { type: 'error', message: 'Invalid sync payload' });
        return;
      }
      console.log(`[*] Broadcasting update in room: ${ws.currentRoom}`);
      const ts = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
      for (const client of clients) {
        if (client !== ws) {
          sendJson(client, { type: 'update', payload, timestamp: ts });
        }
      }
      return;
    }

    if (type === 'request_state') {
      console.log(`[*] Forwarding state request in room: ${ws.currentRoom}`);
      for (const client of clients) {
        if (client !== ws) {
          sendJson(client, { type: 'request_state', roomId: ws.currentRoom });
        }
      }
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(ws);
  });

  ws.on('error', (error) => {
    console.error('[-] WebSocket client error:', error.message);
    leaveCurrentRoom(ws);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      leaveCurrentRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

server.listen(PORT, HOST, () => {
  console.log(`Shadow-Sync Relay Server listening on ${HOST}:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down Shadow-Sync Relay Server...');
  clearInterval(heartbeatTimer);
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);