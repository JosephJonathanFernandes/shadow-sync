import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  type ClientMessage,
  type ServerMessage,
  parseServerMessage,
} from './protocol.js';

export interface NetworkManagerOptions {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export class NetworkManager extends EventEmitter {
  public readonly wsUrl: string;
  public readonly roomId: string;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private pingTimeout: NodeJS.Timeout | null = null;
  private isOffline = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;

  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(wsUrl: string, roomId: string, options: NetworkManagerOptions = {}) {
    super();
    this.wsUrl = wsUrl;
    this.roomId = roomId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  public connect(): void {
    this.shouldReconnect = true;
    this.clearTimers();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;

      const wasReconnecting = this.isOffline;
      this.isOffline = false;
      this.reconnectAttempts = 0;

      // Join room and request state from existing peers
      this.send({ type: 'join', roomId: this.roomId });
      this.send({ type: 'request_state', roomId: this.roomId });

      this.emit('connected', {
        wsUrl: this.wsUrl,
        roomId: this.roomId,
        reconnected: wasReconnecting,
      });

      this.startHeartbeat(ws);
    });

    ws.on('pong', () => {
      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
      }
    });

    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const parsed: ServerMessage | null = parseServerMessage(text);
      if (!parsed) {
        this.emit('error', new Error('Received malformed message from relay server'));
        return;
      }
      this.emit('message', parsed);
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.clearTimers();

      const wasOffline = this.isOffline;
      this.isOffline = true;
      this.emit('disconnected', wasOffline);

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  public send(message: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Client shutdown');
      }
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      ws.ping();
      if (this.pingTimeout) {
        clearTimeout(this.pingTimeout);
      }
      this.pingTimeout = setTimeout(() => {
        this.emit('error', new Error('Heartbeat timeout. Terminating stale connection...'));
        ws.terminate();
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private scheduleReconnect(): void {
    const expDelay = Math.min(
      this.baseReconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maxReconnectDelayMs,
    );
    // Add +/- 20% jitter to avoid thundering herd on server restart
    const jitter = expDelay * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.round(expDelay + jitter));
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }
}
