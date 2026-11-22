import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.shadow-sync.json';
export const PASSPHRASE_ENV_VAR = 'SHADOW_SYNC_PASSPHRASE';
export const SERVER_URL_ENV_VAR = 'SYNC_WS_URL';

export interface ProfileConfig {
  roomId: string;
  passphrase?: string;
  file?: string;
  serverUrl?: string;
  ignoreKeys?: string[];
}

export interface ShadowSyncConfig extends ProfileConfig {
  profiles?: Record<string, ProfileConfig>;
}

export interface SaveConfigOptions {
  cwd?: string;
  savePassphrase?: boolean;
  file?: string;
  serverUrl?: string;
  ignoreKeys?: string[];
  profile?: string;
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

function buildProfileEntry(
  roomId: string,
  passphrase: string | undefined,
  options: SaveConfigOptions,
): ProfileConfig {
  const savePassphrase = options.savePassphrase ?? true;
  const entry: ProfileConfig = { roomId };
  if (savePassphrase && passphrase !== undefined) {
    entry.passphrase = passphrase;
  }
  if (options.file && options.file !== '.env') {
    entry.file = options.file;
  }
  if (options.serverUrl) {
    entry.serverUrl = options.serverUrl;
  }
  if (options.ignoreKeys && options.ignoreKeys.length > 0) {
    entry.ignoreKeys = [...new Set(options.ignoreKeys.map((k) => k.trim()).filter(Boolean))];
  }
  return entry;
}

/**
 * Saves room configuration to .shadow-sync.json with owner-only permissions (0600)
 * and guarantees .gitignore protection. Supports named multi-environment profiles.
 */
export function saveConfig(
  roomId: string,
  passphrase?: string,
  options: SaveConfigOptions = {},
): SaveConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.join(cwd, CONFIG_FILE);

  let existing: Partial<ShadowSyncConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ShadowSyncConfig>;
    } catch {
      existing = {};
    }
  }

  const entry = buildProfileEntry(roomId, passphrase, options);
  let nextConfig: Partial<ShadowSyncConfig>;

  if (options.profile) {
    const profiles = { ...(existing.profiles ?? {}), [options.profile]: entry };
    nextConfig = {
      ...existing,
      profiles,
    };
  } else {
    nextConfig = {
      ...entry,
      ...(existing.profiles ? { profiles: existing.profiles } : {}),
    };
  }

  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

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

function normalizeProfile(raw: Partial<ProfileConfig>, label: string): ProfileConfig {
  if (typeof raw.roomId !== 'string' || raw.roomId.trim() === '') {
    throw new Error(`Invalid ${CONFIG_FILE} (${label}): missing or empty "roomId"`);
  }
  return {
    roomId: raw.roomId,
    passphrase: typeof raw.passphrase === 'string' ? raw.passphrase : undefined,
    file: typeof raw.file === 'string' ? raw.file : undefined,
    serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : undefined,
    ignoreKeys: Array.isArray(raw.ignoreKeys)
      ? raw.ignoreKeys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : undefined,
  };
}

/**
 * Loads .shadow-sync.json from the specified directory (defaults to CWD).
 * If `profile` is provided, resolves that named profile from `profiles[profile]`.
 */
export function loadConfig(
  cwd: string = process.cwd(),
  profile?: string,
): ProfileConfig | null {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<ShadowSyncConfig>;

  if (profile) {
    const profileEntry = parsed.profiles?.[profile];
    if (!profileEntry) {
      throw new Error(`Profile "${profile}" not found in ${CONFIG_FILE}`);
    }
    return normalizeProfile(profileEntry, `profile "${profile}"`);
  }

  return normalizeProfile(parsed, 'default');
}

/**
 * Lists all named profile keys defined in .shadow-sync.json.
 */
export function listProfiles(cwd: string = process.cwd()): string[] {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ShadowSyncConfig>;
  return parsed.profiles ? Object.keys(parsed.profiles).sort() : [];
}

/**
 * Resolves the passphrase from environment variable first, then config.
 */
export function resolvePassphrase(config?: ProfileConfig | null): string | undefined {
  const fromEnv = process.env[PASSPHRASE_ENV_VAR];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (config?.passphrase && config.passphrase.length > 0) {
    return config.passphrase;
  }
  return undefined;
}
