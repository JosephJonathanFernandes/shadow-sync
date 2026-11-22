import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  MAX_PAYLOAD_BYTES,
  parseClientMessage,
  type ServerMessage,
} from './protocol.js';

interface TrackedSocket extends WebSocket {
  isAlive: boolean;
  currentRoom: string | null;
}

interface RoomSnapshot {
  payload: string;
  timestamp: number;
  cachedAt: number;
}

export interface RelayServerOptions {
  port?: number;
  host?: string;
  heartbeatIntervalMs?: number;
  maxPayloadBytes?: number;
  /** How long opaque encrypted room snapshots are retained in memory (default: 24h). Set 0 to disable. */
  snapshotTtlMs?: number;
  /** Maximum number of rooms to retain in the LRU snapshot cache (default: 500). */
  maxCachedRooms?: number;
  logger?: Pick<Console, 'log' | 'error'>;
}

export interface RelayServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  url: string;
  getStats: () => { rooms: number; clients: number; cachedRooms: number };
  close: () => Promise<void>;
}

const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_CACHED_ROOMS = 500;

/**
 * Starts a zero-trust Shadow-Sync WebSocket relay server with HTTP /health
 * endpoint, payload size limits, room cleanup, dead-peer eviction, and an
 * optional zero-trust encrypted snapshot cache (TTL + LRU) for async teams.
 */
export async function createRelayServer(
  options: RelayServerOptions = {},
): Promise<RelayServerHandle> {
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? Number(process.env.PORT ?? 8080);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const maxPayload = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  const snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const maxCachedRooms = options.maxCachedRooms ?? DEFAULT_MAX_CACHED_ROOMS;
  const logger = options.logger ?? console;

  const rooms = new Map<string, Set<TrackedSocket>>();
  const snapshots = new Map<string, RoomSnapshot>();

  const pruneExpiredSnapshots = (): void => {
    if (snapshotTtlMs <= 0) {
      snapshots.clear();
      return;
    }
    const now = Date.now();
    for (const [roomId, snap] of snapshots) {
      if (now - snap.cachedAt > snapshotTtlMs) {
        snapshots.delete(roomId);
      }
    }
  };

  const setSnapshot = (roomId: string, payload: string, timestamp: number): void => {
    if (snapshotTtlMs <= 0 || maxCachedRooms <= 0) return;

    // Refresh LRU position by deleting and re-inserting
    if (snapshots.has(roomId)) {
      snapshots.delete(roomId);
    }
    snapshots.set(roomId, { payload, timestamp, cachedAt: Date.now() });

    while (snapshots.size > maxCachedRooms) {
      const oldestKey = snapshots.keys().next().value;
      if (oldestKey !== undefined) {
        snapshots.delete(oldestKey);
      } else {
        break;
      }
    }
  };

  const getSnapshot = (roomId: string): RoomSnapshot | null => {
    if (snapshotTtlMs <= 0) return null;
    const snap = snapshots.get(roomId);
    if (!snap) return null;
    if (Date.now() - snap.cachedAt > snapshotTtlMs) {
      snapshots.delete(roomId);
      return null;
    }
    // Touch LRU position
    snapshots.delete(roomId);
    snapshots.set(roomId, snap);
    return snap;
  };

  const sendMessage = (client: WebSocket, msg: ServerMessage): void => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  };

  const broadcastPeerCount = (roomId: string): void => {
    const clients = rooms.get(roomId);
    if (!clients) return;
    const count = clients.size;
    for (const client of clients) {
      sendMessage(client, { type: 'peer_count', roomId, count });
    }
  };

  const leaveCurrentRoom = (ws: TrackedSocket): void => {
    const roomId = ws.currentRoom;
    if (!roomId) return;

    const clients = rooms.get(roomId);
    if (clients) {
      clients.delete(ws);
      logger.log(`[-] Client left room: ${roomId} (${clients.size} remaining)`);
      if (clients.size === 0) {
        rooms.delete(roomId);
        logger.log(`[!] Room ${roomId} is empty.`);
      } else {
        broadcastPeerCount(roomId);
      }
    }
    ws.currentRoom = null;
  };

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      pruneExpiredSnapshots();
      const body = JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        clients: wss.clients.size,
        cachedRooms: snapshots.size,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Shadow-Sync Relay Server — Upgrade to WebSocket required');
  });

  const wss = new WebSocketServer({ server, maxPayload });

  wss.on('connection', (rawWs) => {
    const ws = rawWs as TrackedSocket;
    ws.isAlive = true;
    ws.currentRoom = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const message = parseClientMessage(text);

      if (!message) {
        sendMessage(ws, { type: 'error', message: 'Invalid message format' });
        return;
      }

      if (message.type === 'join') {
        if (ws.currentRoom && ws.currentRoom !== message.roomId) {
          leaveCurrentRoom(ws);
        }
        ws.currentRoom = message.roomId;
        let clients = rooms.get(message.roomId);
        if (!clients) {
          clients = new Set<TrackedSocket>();
          rooms.set(message.roomId, clients);
        }
        clients.add(ws);
        logger.log(`[+] Client joined room: ${message.roomId} (${clients.size} online)`);
        broadcastPeerCount(message.roomId);
        return;
      }

      if (!ws.currentRoom || ws.currentRoom !== message.roomId) {
        sendMessage(ws, { type: 'error', message: 'Must join room before sending messages' });
        return;
      }

      const clients = rooms.get(ws.currentRoom);
      if (!clients) return;

      if (message.type === 'sync') {
        logger.log(`[*] Broadcasting update in room: ${ws.currentRoom}`);
        setSnapshot(ws.currentRoom, message.payload, message.timestamp);
        for (const client of clients) {
          if (client !== ws) {
            sendMessage(client, {
              type: 'update',
              payload: message.payload,
              timestamp: message.timestamp,
            });
          }
        }
        return;
      }

      if (message.type === 'request_state') {
        logger.log(`[*] Handling state request in room: ${ws.currentRoom}`);
        // Serve cached opaque encrypted snapshot immediately for async/offline teams
        const cached = getSnapshot(ws.currentRoom);
        if (cached) {
          sendMessage(ws, {
            type: 'update',
            payload: cached.payload,
            timestamp: cached.timestamp,
          });
        }
        // Also forward to online peers in case they hold fresher state
        for (const client of clients) {
          if (client !== ws) {
            sendMessage(client, {
              type: 'request_state',
              roomId: ws.currentRoom,
            });
          }
        }
      }
    });

    ws.on('close', () => {
      leaveCurrentRoom(ws);
    });

    ws.on('error', (error) => {
      logger.error('[-] WebSocket client error:', error.message);
      leaveCurrentRoom(ws);
    });
  });

  const heartbeatTimer = setInterval(() => {
    pruneExpiredSnapshots();
    for (const rawWs of wss.clients) {
      const ws = rawWs as TrackedSocket;
      if (!ws.isAlive) {
        leaveCurrentRoom(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === 'object' && address !== null ? address.port : requestedPort;
  const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  return {
    server,
    wss,
    port: boundPort,
    url: `ws://${connectHost}:${boundPort}`,
    getStats: () => {
      pruneExpiredSnapshots();
      return {
        rooms: rooms.size,
        clients: wss.clients.size,
        cachedRooms: snapshots.size,
      };
    },
    close: async () => {
      clearInterval(heartbeatTimer);
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const port = Number(process.env.PORT ?? 8080);
  createRelayServer({ port }).then((relay) => {
    console.log(`Shadow-Sync Relay Server listening on port ${relay.port}`);

    const shutdown = async () => {
      console.log('\nShutting down Shadow-Sync Relay Server...');
      await relay.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
