export const DEFAULT_RELAY_URL = 'wss://shadow-sync.onrender.com';
export const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB
export const MAX_ROOM_ID_LENGTH = 64;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export interface JoinMessage {
  type: 'join';
  roomId: string;
}

export interface SyncMessage {
  type: 'sync';
  roomId: string;
  payload: string;
  timestamp: number;
}

export interface RequestStateMessage {
  type: 'request_state';
  roomId: string;
}

export type ClientMessage = JoinMessage | SyncMessage | RequestStateMessage;

export interface UpdateMessage {
  type: 'update';
  payload: string;
  timestamp?: number;
}

export interface ServerRequestStateMessage {
  type: 'request_state';
  roomId: string;
}

export interface PeerCountMessage {
  type: 'peer_count';
  roomId: string;
  count: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | UpdateMessage
  | ServerRequestStateMessage
  | PeerCountMessage
  | ErrorMessage;

export function isValidRoomId(roomId: unknown): roomId is string {
  return (
    typeof roomId === 'string' &&
    roomId.length <= MAX_ROOM_ID_LENGTH &&
    ROOM_ID_PATTERN.test(roomId)
  );
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  const { type, roomId } = msg;

  if (!isValidRoomId(roomId)) {
    return null;
  }

  if (type === 'join') {
    return { type: 'join', roomId };
  }

  if (type === 'request_state') {
    return { type: 'request_state', roomId };
  }

  if (type === 'sync') {
    if (typeof msg.payload !== 'string' || msg.payload.length === 0) {
      return null;
    }
    const timestamp =
      typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
        ? msg.timestamp
        : Date.now();
    return {
      type: 'sync',
      roomId,
      payload: msg.payload,
      timestamp,
    };
  }

  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const msg = parsed as Record<string, unknown>;

  if (msg.type === 'update' && typeof msg.payload === 'string') {
    return {
      type: 'update',
      payload: msg.payload,
      timestamp:
        typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
          ? msg.timestamp
          : undefined,
    };
  }

  if (msg.type === 'request_state' && typeof msg.roomId === 'string') {
    return {
      type: 'request_state',
      roomId: msg.roomId,
    };
  }

  if (
    msg.type === 'peer_count' &&
    typeof msg.roomId === 'string' &&
    typeof msg.count === 'number'
  ) {
    return {
      type: 'peer_count',
      roomId: msg.roomId,
      count: msg.count,
    };
  }

  if (msg.type === 'error' && typeof msg.message === 'string') {
    return {
      type: 'error',
      message: msg.message,
    };
  }

  return null;
}
