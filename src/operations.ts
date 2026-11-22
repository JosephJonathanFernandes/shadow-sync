import WebSocket from 'ws';
import {
  DecryptionError,
  decryptEnvelope,
  deriveKey,
  encryptEnvelope,
  generateRoomId,
} from './crypto.js';
import {
  type EnvDiffEntry,
  computeEnvDiff,
  mergeEnvStates,
  updateKeyStateMap,
} from './envMerge.js';
import {
  DEFAULT_RELAY_URL,
  parseServerMessage,
  type ClientMessage,
} from './protocol.js';
import { StateManager } from './stateManager.js';
import { SERVER_URL_ENV_VAR, saveConfig } from './config.js';

export interface OneShotOptions {
  roomId: string;
  key: Buffer;
  filePath?: string;
  wsUrl?: string;
  ignoreKeys?: readonly string[];
  timeoutMs?: number;
}

export interface PushOnceResult {
  roomId: string;
  timestamp: number;
  keyCount: number;
}

export interface PullOnceResult {
  received: boolean;
  applied: boolean;
  diffs: EnvDiffEntry[];
}

export interface RotateRoomOptions {
  newPassphrase: string;
  newRoomId?: string;
  filePath?: string;
  wsUrl?: string;
  ignoreKeys?: readonly string[];
  savePassphrase?: boolean;
  profile?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RotateRoomResult {
  newRoomId: string;
  pushed: boolean;
  keyCount: number;
}

function connectOneShot(wsUrl: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to relay server (${wsUrl})`));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(msg), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function closeOneShot(ws: WebSocket, reason: string): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 500);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close(1000, reason);
  });
}

/**
 * One-shot push: encrypts the local .env (stripping ignoreKeys) as a v2 envelope,
 * broadcasts to the room & caches it on the relay, then disconnects cleanly.
 */
export async function pushOnce(options: OneShotOptions): Promise<PushOnceResult> {
  const filePath = options.filePath ?? '.env';
  const ignoreKeys = options.ignoreKeys ?? [];
  const timeoutMs = options.timeoutMs ?? 5_000;
  const wsUrl = options.wsUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;

  const stateManager = new StateManager(filePath, ignoreKeys);
  const local = await stateManager.getLocalState();
  const timestamp = local.timestamp > 0 ? local.timestamp : Date.now();
  const keys =
    Object.keys(local.keys).length > 0
      ? local.keys
      : updateKeyStateMap({}, local.broadcastContent, timestamp, ignoreKeys);

  const payload = encryptEnvelope(
    local.broadcastContent,
    timestamp,
    options.key,
    options.roomId,
    keys,
  );

  const ws = await connectOneShot(wsUrl, timeoutMs);
  try {
    await sendClientMessage(ws, { type: 'join', roomId: options.roomId });
    await sendClientMessage(ws, {
      type: 'sync',
      roomId: options.roomId,
      payload,
      timestamp,
    });
    // Allow brief flush before closing cleanly
    await new Promise((r) => setTimeout(r, 75));
  } finally {
    await closeOneShot(ws, 'push complete');
  }

  return {
    roomId: options.roomId,
    timestamp,
    keyCount: Object.keys(keys).length,
  };
}

/**
 * One-shot pull (or dry-run diff): connects to the relay, requests room state
 * (served from relay cache and/or online peers), computes masked key diffs,
 * and optionally merges into the local .env file.
 */
export async function pullOnce(
  options: OneShotOptions & { dryRun?: boolean },
): Promise<PullOnceResult> {
  const filePath = options.filePath ?? '.env';
  const ignoreKeys = options.ignoreKeys ?? [];
  const timeoutMs = options.timeoutMs ?? 3_000;
  const dryRun = options.dryRun ?? false;
  const wsUrl = options.wsUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;

  const stateManager = new StateManager(filePath, ignoreKeys);
  const local = await stateManager.getLocalState();

  const ws = await connectOneShot(wsUrl, timeoutMs);

  try {
    await sendClientMessage(ws, { type: 'join', roomId: options.roomId });

    const envelope = await new Promise<ReturnType<typeof decryptEnvelope> | null>(
      (resolve, reject) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);

        ws.on('message', (data) => {
          const text = typeof data === 'string' ? data : data.toString('utf8');
          const msg = parseServerMessage(text);
          if (!msg || msg.type !== 'update') return;

          try {
            const decoded = decryptEnvelope(msg.payload, options.key, options.roomId);
            clearTimeout(timer);
            resolve(decoded);
          } catch (err) {
            if (err instanceof DecryptionError) {
              clearTimeout(timer);
              reject(err);
            }
          }
        });

        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        sendClientMessage(ws, { type: 'request_state', roomId: options.roomId }).catch(
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      },
    );

    if (!envelope) {
      return { received: false, applied: false, diffs: [] };
    }

    const remoteKeys =
      envelope.keys ??
      updateKeyStateMap({}, envelope.content, envelope.timestamp, ignoreKeys);

    const previewMerge = mergeEnvStates({
      localContent: local.content,
      localKeys: local.keys,
      remoteContent: envelope.content,
      remoteKeys,
      ignoreKeys,
    });

    const diffs = computeEnvDiff(local.content, previewMerge.mergedContent, ignoreKeys);

    if (dryRun) {
      return { received: true, applied: false, diffs };
    }

    const res = await stateManager.evaluateUpdate(
      envelope.content,
      envelope.timestamp,
      envelope.keys,
    );

    const applied =
      res.action === 'updated' || (res.action === 'pushback' && Boolean(res.updatedLocal));

    return { received: true, applied, diffs };
  } finally {
    await closeOneShot(ws, 'pull complete');
  }
}

/**
 * Rotates a room's credentials by generating a fresh Room ID (or using a supplied one),
 * deriving a new key from the new passphrase, updating .shadow-sync.json, and pushing
 * the freshly re-encrypted .env to the new room.
 */
export async function rotateRoom(options: RotateRoomOptions): Promise<RotateRoomResult> {
  const newRoomId = options.newRoomId ?? generateRoomId();
  const filePath = options.filePath ?? '.env';
  const ignoreKeys = options.ignoreKeys ?? [];
  const wsUrl = options.wsUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
  const newKey = deriveKey(options.newPassphrase, newRoomId);

  saveConfig(newRoomId, options.newPassphrase, {
    cwd: options.cwd,
    savePassphrase: options.savePassphrase ?? true,
    file: filePath,
    serverUrl: options.wsUrl,
    ignoreKeys: [...ignoreKeys],
    profile: options.profile,
  });

  const pushed = await pushOnce({
    roomId: newRoomId,
    key: newKey,
    filePath,
    wsUrl,
    ignoreKeys,
    timeoutMs: options.timeoutMs,
  });

  return {
    newRoomId,
    pushed: true,
    keyCount: pushed.keyCount,
  };
}
