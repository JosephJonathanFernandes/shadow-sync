import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.shadow-sync.json';
export const PASSPHRASE_ENV_VAR = 'SHADOW_SYNC_PASSPHRASE';
export const SERVER_URL_ENV_VAR = 'SYNC_WS_URL';

export interface ShadowSyncConfig {
  roomId: string;
  passphrase?: string;
  file?: string;
  serverUrl?: string;
}

export interface SaveConfigOptions {
  cwd?: string;
  savePassphrase?: boolean;
  file?: string;
  serverUrl?: string;
}

export interface SaveConfigResult {
  configPath: string;
  gitignoreUpdated: boolean;
  gitignoreCreated: boolean;
}

/**
 * Ensures CONFIG_FILE is listed as a dedicated line in .gitignore.
 * Creates .gitignore if it does not already exist.
 */
export function ensureGitignoreProtected(cwd: string = process.cwd()): {
  updated: boolean;
  created: boolean;
} {
  const gitignorePath = path.join(cwd, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${CONFIG_FILE}\n`, 'utf8');
    return { updated: true, created: true };
  }

  const content = fs.readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/).map((line) => line.trim());

  if (lines.includes(CONFIG_FILE)) {
    return { updated: false, created: false };
  }

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${prefix}${CONFIG_FILE}\n`, 'utf8');
  return { updated: true, created: false };
}

/**
 * Checks whether .shadow-sync.json is protected in .gitignore.
 */
export function isGitignoreProtected(cwd: string = process.cwd()): boolean {
  const gitignorePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const content = fs.readFileSync(gitignorePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(CONFIG_FILE);
}

/**
 * Saves room configuration to .shadow-sync.json with owner-only permissions (0600)
 * and guarantees .gitignore protection.
 */
export function saveConfig(
  roomId: string,
  passphrase?: string,
  options: SaveConfigOptions = {},
): SaveConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const savePassphrase = options.savePassphrase ?? true;
  const configPath = path.join(cwd, CONFIG_FILE);

  const data: ShadowSyncConfig = { roomId };
  if (savePassphrase && passphrase !== undefined) {
    data.passphrase = passphrase;
  }
  if (options.file && options.file !== '.env') {
    data.file = options.file;
  }
  if (options.serverUrl) {
    data.serverUrl = options.serverUrl;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  // Explicitly enforce 0600 even if the file already existed with wider permissions
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // chmod may not be supported on some non-POSIX filesystems
  }

  const gitignore = ensureGitignoreProtected(cwd);

  return {
    configPath,
    gitignoreUpdated: gitignore.updated,
    gitignoreCreated: gitignore.created,
  };
}

/**
 * Loads .shadow-sync.json from the specified directory (defaults to CWD).
 * Returns null if the config file does not exist.
 */
export function loadConfig(cwd: string = process.cwd()): ShadowSyncConfig | null {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ShadowSyncConfig>;

  if (typeof parsed.roomId !== 'string' || parsed.roomId.trim() === '') {
    throw new Error(`Invalid ${CONFIG_FILE}: missing or empty "roomId"`);
  }

  return {
    roomId: parsed.roomId,
    passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : undefined,
    file: typeof parsed.file === 'string' ? parsed.file : undefined,
    serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : undefined,
  };
}

/**
 * Resolves the passphrase from environment variable first, then config.
 */
export function resolvePassphrase(config?: ShadowSyncConfig | null): string | undefined {
  const fromEnv = process.env[PASSPHRASE_ENV_VAR];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (config?.passphrase && config.passphrase.length > 0) {
    return config.passphrase;
  }
  return undefined;
}
