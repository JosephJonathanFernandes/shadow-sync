import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import {
  DecryptionError,
  decryptEnvelope,
  encryptEnvelope,
} from './crypto.js';
import type { KeyStateMap } from './envMerge.js';
import {
  NetworkManager,
  type NetworkManagerOptions,
} from './networkManager.js';
import { DEFAULT_RELAY_URL, type ServerMessage } from './protocol.js';
import { StateManager } from './stateManager.js';
import { startWatching, type FileWatcherHandle } from './watcher.js';
import { SERVER_URL_ENV_VAR } from './config.js';

export interface SyncClientOptions {
  roomId: string;
  key: Buffer;
  filePath?: string;
  wsUrl?: string;
  ignoreKeys?: readonly string[];
  silent?: boolean;
  debounceMs?: number;
  networkOptions?: NetworkManagerOptions;
  onUpdateApplied?: (content: string) => void;
  onDecryptionError?: (error: DecryptionError) => void;
}

export interface SyncClientHandle {
  network: NetworkManager;
  stateManager: StateManager;
  stop: () => Promise<void>;
}

export async function startSyncClient(
  options: SyncClientOptions,
): Promise<SyncClientHandle> {
  const {
    roomId,
    key,
    filePath = '.env',
    ignoreKeys = [],
    silent = false,
    debounceMs,
    networkOptions,
  } = options;

  const wsUrl = options.wsUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
  const stateManager = new StateManager(filePath, ignoreKeys);

  const log = (msg: string) => {
    if (!silent) console.log(msg);
  };
  const logError = (msg: string) => {
    if (!silent) console.error(msg);
  };

  const { created } = await stateManager.getLocalState();
  if (created) {
    log(chalk.yellow(`Created empty ${filePath} for cold start.`));
  }
  if (ignoreKeys.length > 0) {
    log(chalk.dim(`ℹ Local-only ignored keys: ${ignoreKeys.join(', ')}`));
  }

  const network = new NetworkManager(wsUrl, roomId, networkOptions);
  let spinner: Ora | null = silent
    ? null
    : ora(`Connecting to Sync Server (${wsUrl})...`).start();
  let isOffline = false;

  const broadcastState = (
    content: string,
    timestamp: number,
    keys: KeyStateMap,
  ): boolean => {
    const payload = encryptEnvelope(content, timestamp, key, roomId, keys);
    return network.send({
      type: 'sync',
      roomId,
      payload,
      timestamp,
    });
  };

  // Start watching immediately so offline edits are tracked and process stays alive
  const watcher: FileWatcherHandle = startWatching(
    (fileContent) => {
      const connected = network.isConnected();
      const tracked = stateManager.trackLocalUpdate(fileContent, !connected);
      if (tracked === null) return;

      if (!connected) {
        log(chalk.yellow('Offline: changes saved locally and will sync upon reconnect.'));
        return;
      }

      const syncSpinner = silent ? null : ora('Encrypting and syncing changes...').start();
      try {
        broadcastState(tracked.broadcastContent, tracked.timestamp, tracked.keys);
        syncSpinner?.succeed(chalk.green('Changes encrypted and synced!'));
      } catch (err) {
        syncSpinner?.fail(chalk.red('Failed to sync changes.'));
        logError(err instanceof Error ? err.message : String(err));
      }
    },
    {
      filePath,
      debounceMs,
      onError: (err) => {
        logError(chalk.red(`[-] Watcher error: ${err.message}`));
      },
    },
  );

  network.on('connected', async ({ reconnected }: { reconnected: boolean }) => {
    isOffline = false;
    if (spinner) {
      spinner.succeed(chalk.green(`Connected to Sync Server: ${wsUrl}`));
      spinner = null;
    } else if (reconnected) {
      log(chalk.green(`✔ Reconnected to Sync Server: ${wsUrl}`));
    }
    log(chalk.cyan(`Joined room: ${roomId}`));

    // If local edits were made while offline, push them immediately so LWW CRDT merges
    if (stateManager.hasPendingLocalChanges()) {
      try {
        const local = await stateManager.getLocalState();
        if (broadcastState(local.broadcastContent, local.timestamp, local.keys)) {
          stateManager.clearPendingLocalChanges();
          log(chalk.cyan('↑ Pushed pending offline changes after reconnect.'));
        }
      } catch (err) {
        logError(
          chalk.red(
            `[-] Failed to push offline changes: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  });

  network.on('disconnected', (wasOffline: boolean) => {
    if (!wasOffline) {
      isOffline = true;
      if (spinner?.isSpinning) {
        spinner.stop();
      }
      log(chalk.yellow('[-] Connection lost. Reconnecting with backoff...'));
    }
  });

  network.on('error', (err: Error) => {
    if (!isOffline) {
      if (spinner?.isSpinning) {
        spinner.fail(chalk.red('Connection failed. Retrying in background...'));
        spinner = null;
      }
      logError(chalk.red(`[-] Network error: ${err.message || String(err)}`));
    }
  });

  network.on('message', async (message: ServerMessage) => {
    try {
      if (message.type === 'peer_count') {
        const others = Math.max(0, message.count - 1);
        log(
          chalk.dim(
            `ℹ Room ${message.roomId}: ${others} other peer${others === 1 ? '' : 's'} online`,
          ),
        );
        return;
      }

      if (message.type === 'error') {
        logError(chalk.red(`[-] Relay server error: ${message.message}`));
        return;
      }

      if (message.type === 'request_state') {
        const local = await stateManager.getLocalState();
        if (local.broadcastContent.trim() === '') {
          return;
        }
        broadcastState(local.broadcastContent, local.timestamp, local.keys);
        log(chalk.cyan('↑ Synced encrypted local state to peer.'));
        return;
      }

      if (message.type === 'update') {
        const envelope = decryptEnvelope(message.payload, key, roomId);
        const result = await stateManager.evaluateUpdate(
          envelope.content,
          envelope.timestamp,
          envelope.keys,
        );

        if (result.action === 'pushback') {
          if (result.reason === 'empty_overwrite') {
            log(
              chalk.yellow(
                `⚠ Refusing to overwrite ${filePath} with empty sync. Pushing local state back...`,
              ),
            );
          } else if (result.reason === 'merged_conflict') {
            log(
              chalk.cyan(
                `⇄ Merged concurrent edits in ${filePath}. Pushing reconciled state back...`,
              ),
            );
            options.onUpdateApplied?.(result.localContent);
          } else {
            log(
              chalk.yellow(
                `⚠ Local ${filePath} has newer keys than incoming sync. Pushing local state back...`,
              ),
            );
          }
          broadcastState(result.localContent, result.localTimestamp, result.localKeys);
        } else if (result.action === 'updated') {
          log(chalk.green(`↓ Received and applied remote update to ${filePath}.`));
          options.onUpdateApplied?.(envelope.content);
        }
      }
    } catch (error) {
      if (error instanceof DecryptionError) {
        logError(
          chalk.red(
            '✖ Decryption failed: a peer in this room may be using a different passphrase.',
          ),
        );
        options.onDecryptionError?.(error);
        return;
      }
      logError(
        chalk.red(
          `[-] Error processing incoming message: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });

  network.connect();

  return {
    network,
    stateManager,
    stop: async () => {
      network.disconnect();
      await watcher.close();
    },
  };
}
