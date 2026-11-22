import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  PASSPHRASE_ENV_VAR,
  isGitignoreProtected,
  loadConfig,
  resolvePassphrase,
  saveConfig,
} from '../src/config.js';

describe('config', () => {
  let tmpDir: string;
  const originalEnvPassphrase = process.env[PASSPHRASE_ENV_VAR];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-sync-config-'));
    delete process.env[PASSPHRASE_ENV_VAR];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnvPassphrase === undefined) {
      delete process.env[PASSPHRASE_ENV_VAR];
    } else {
      process.env[PASSPHRASE_ENV_VAR] = originalEnvPassphrase;
    }
  });

  it('saves config with 0600 permissions and creates .gitignore if missing', () => {
    const result = saveConfig('ABCD-1234', 'my-secret', { cwd: tmpDir });
    expect(result.gitignoreCreated).toBe(true);
    expect(result.gitignoreUpdated).toBe(true);
    expect(isGitignoreProtected(tmpDir)).toBe(true);

    const mode = fs.statSync(result.configPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const loaded = loadConfig(tmpDir);
    expect(loaded).toEqual({
      roomId: 'ABCD-1234',
      passphrase: 'my-secret',
      file: undefined,
      serverUrl: undefined,
    });
  });

  it('appends .shadow-sync.json to existing .gitignore idempotently', () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/', 'utf8');

    const first = saveConfig('ROOM-1', 'pass', { cwd: tmpDir });
    expect(first.gitignoreCreated).toBe(false);
    expect(first.gitignoreUpdated).toBe(true);

    const second = saveConfig('ROOM-1', 'pass', { cwd: tmpDir });
    expect(second.gitignoreUpdated).toBe(false);

    const lines = fs
      .readFileSync(gitignorePath, 'utf8')
      .split('\n')
      .filter((l) => l === CONFIG_FILE);
    expect(lines.length).toBe(1);
  });

  it('omits passphrase when savePassphrase is false', () => {
    saveConfig('ROOM-2', 'secret', {
      cwd: tmpDir,
      savePassphrase: false,
      file: '.env.local',
      serverUrl: 'ws://localhost:9000',
    });

    const loaded = loadConfig(tmpDir);
    expect(loaded).toEqual({
      roomId: 'ROOM-2',
      passphrase: undefined,
      file: '.env.local',
      serverUrl: 'ws://localhost:9000',
    });
  });

  it('returns null when config file does not exist', () => {
    expect(loadConfig(tmpDir)).toBeNull();
  });

  it('prefers SHADOW_SYNC_PASSPHRASE env var over config file', () => {
    process.env[PASSPHRASE_ENV_VAR] = 'from-env';
    expect(resolvePassphrase({ roomId: 'R1', passphrase: 'from-config' })).toBe('from-env');

    delete process.env[PASSPHRASE_ENV_VAR];
    expect(resolvePassphrase({ roomId: 'R1', passphrase: 'from-config' })).toBe('from-config');
    expect(resolvePassphrase({ roomId: 'R1' })).toBeUndefined();
  });
});
