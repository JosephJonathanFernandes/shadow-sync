export {
  CONFIG_FILE,
  PASSPHRASE_ENV_VAR,
  SERVER_URL_ENV_VAR,
  ensureGitignoreProtected,
  isGitignoreProtected,
  loadConfig,
  resolvePassphrase,
  saveConfig,
  type SaveConfigOptions,
  type SaveConfigResult,
  type ShadowSyncConfig,
} from './config.js';
export {
  DecryptionError,
  decryptEnv,
  decryptEnvelope,
  deriveKey,
  encryptEnv,
  encryptEnvelope,
  generateRoomId,
  type SyncEnvelope,
} from './crypto.js';
export {
  NetworkManager,
  type NetworkManagerOptions,
} from './networkManager.js';
export {
  DEFAULT_RELAY_URL,
  MAX_PAYLOAD_BYTES,
  MAX_ROOM_ID_LENGTH,
  isValidRoomId,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';
export {
  createRelayServer,
  type RelayServerHandle,
  type RelayServerOptions,
} from './server.js';
export {
  StateManager,
  type LocalState,
  type UpdateEvaluationResult,
} from './stateManager.js';
export {
  startSyncClient,
  type SyncClientHandle,
  type SyncClientOptions,
} from './sync.js';
export {
  startWatching,
  type FileWatcherHandle,
  type WatcherOptions,
} from './watcher.js';
