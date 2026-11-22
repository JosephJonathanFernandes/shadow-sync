import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateManager } from '../src/stateManager.js';

describe('StateManager', () => {
  let tmpDir: string;
  let envPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-sync-state-'));
    envPath = path.join(tmpDir, '.env');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates an empty .env with timestamp 0 on cold start so older peer state wins', async () => {
    const sm = new StateManager(envPath);
    const local = await sm.getLocalState();
    expect(local.created).toBe(true);
    expect(local.content).toBe('');
    expect(local.timestamp).toBe(0);

    // Incoming update from a teammate whose .env was edited 1 hour ago MUST win
    const olderTimestamp = Date.now() - 3_600_000;
    const res = await sm.evaluateUpdate('DB_HOST=localhost\n', olderTimestamp);
    expect(res).toEqual({ action: 'updated' });
    expect(await fs.readFile(envPath, 'utf8')).toBe('DB_HOST=localhost\n');
  });

  it('refuses to overwrite populated local .env with an empty incoming payload', async () => {
    await fs.writeFile(envPath, 'SECRET=keep-me\n', 'utf8');
    const sm = new StateManager(envPath);
    await sm.getLocalState();

    const res = await sm.evaluateUpdate('   \n', Date.now() + 60_000);
    expect(res.action).toBe('pushback');
    if (res.action === 'pushback') {
      expect(res.reason).toBe('empty_overwrite');
      expect(res.localContent).toBe('SECRET=keep-me\n');
    }
    expect(await fs.readFile(envPath, 'utf8')).toBe('SECRET=keep-me\n');
  });

  it('pushes back when local state is strictly newer (LWW footrace)', async () => {
    await fs.writeFile(envPath, 'VERSION=2\n', 'utf8');
    const sm = new StateManager(envPath);
    const local = await sm.getLocalState();

    const staleIncomingTs = local.timestamp - 10_000;
    const res = await sm.evaluateUpdate('VERSION=1\n', staleIncomingTs);
    expect(res.action).toBe('pushback');
    if (res.action === 'pushback') {
      expect(res.reason).toBe('local_newer');
      expect(res.localContent).toBe('VERSION=2\n');
    }
    expect(await fs.readFile(envPath, 'utf8')).toBe('VERSION=2\n');
  });

  it('applies incoming update when remote timestamp is newer', async () => {
    await fs.writeFile(envPath, 'VERSION=1\n', 'utf8');
    const sm = new StateManager(envPath);
    const local = await sm.getLocalState();

    const newerIncomingTs = local.timestamp + 5_000;
    const res = await sm.evaluateUpdate('VERSION=2\n', newerIncomingTs);
    expect(res).toEqual({ action: 'updated' });
    expect(await fs.readFile(envPath, 'utf8')).toBe('VERSION=2\n');

    // Echo suppression: watcher reading back the same content should be ignored
    expect(sm.trackLocalUpdate('VERSION=2\n')).toBeNull();
  });

  it('ignores identical incoming content to prevent ping-pong loops', async () => {
    await fs.writeFile(envPath, 'SAME=true\n', 'utf8');
    const sm = new StateManager(envPath);
    await sm.getLocalState();

    const res = await sm.evaluateUpdate('SAME=true\n', Date.now());
    expect(res).toEqual({ action: 'ignored', reason: 'identical' });
  });

  it('tracks pending local changes made while offline', async () => {
    await fs.writeFile(envPath, 'A=1\n', 'utf8');
    const sm = new StateManager(envPath);
    await sm.getLocalState();

    expect(sm.hasPendingLocalChanges()).toBe(false);
    const ts = sm.trackLocalUpdate('A=2\n', true);
    expect(ts).toBeGreaterThan(0);
    expect(sm.hasPendingLocalChanges()).toBe(true);

    sm.clearPendingLocalChanges();
    expect(sm.hasPendingLocalChanges()).toBe(false);
  });
});
