import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { deriveKey } from '../src/crypto.js';
import { parseEnvValues } from '../src/envMerge.js';
import { pullOnce, pushOnce, rotateRoom } from '../src/operations.js';
import { createRelayServer, type RelayServerHandle } from '../src/server.js';
import { startSyncClient, type SyncClientHandle } from '../src/sync.js';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Shadow-Sync end-to-end integration', () => {
  let relay: RelayServerHandle;
  let tmpDir: string;
  const clients: SyncClientHandle[] = [];

  const quietLogger = {
    log: () => {},
    error: () => {},
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-sync-e2e-'));
    relay = await createRelayServer({
      port: 0,
      host: '127.0.0.1',
      logger: quietLogger,
    });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      await c.stop();
    }
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serves /health with live room, client, and cachedRooms counts', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      rooms: number;
      clients: number;
      cachedRooms: number;
    };
    expect(body).toEqual({ status: 'ok', rooms: 0, clients: 0, cachedRooms: 0 });
  });

  it('syncs live .env edits between two peers and populates a late cold-start joiner', async () => {
    const roomId = 'E2E-ROOM-1';
    const key = deriveKey('shared-team-passphrase', roomId);

    const envA = path.join(tmpDir, 'peerA.env');
    const envB = path.join(tmpDir, 'peerB.env');

    await fs.writeFile(envA, 'INITIAL=fromA\n', 'utf8');

    const clientA = await startSyncClient({
      roomId,
      key,
      filePath: envA,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientA);

    await waitFor(() => clientA.network.isConnected());

    // Peer B joins late with NO .env file yet (cold start)
    const clientB = await startSyncClient({
      roomId,
      key,
      filePath: envB,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientB);

    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'INITIAL=fromA\n');

    await fs.writeFile(envA, 'INITIAL=fromA\nNEW_KEY=live-sync\n', 'utf8');
    await waitFor(
      async () => (await fs.readFile(envB, 'utf8')) === 'INITIAL=fromA\nNEW_KEY=live-sync\n',
    );
  });

  it('isolates peers with a wrong passphrase without corrupting their local .env', async () => {
    const roomId = 'E2E-ROOM-2';
    const keyGood = deriveKey('correct-passphrase', roomId);
    const keyBad = deriveKey('wrong-passphrase', roomId);

    const envGood = path.join(tmpDir, 'good.env');
    const envBad = path.join(tmpDir, 'bad.env');

    await fs.writeFile(envGood, 'SECRET=real\n', 'utf8');
    await fs.writeFile(envBad, 'LOCAL=untouched\n', 'utf8');

    let decryptionErrors = 0;

    const clientGood = await startSyncClient({
      roomId,
      key: keyGood,
      filePath: envGood,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientGood);
    await waitFor(() => clientGood.network.isConnected());

    const clientBad = await startSyncClient({
      roomId,
      key: keyBad,
      filePath: envBad,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
      onDecryptionError: () => {
        decryptionErrors += 1;
      },
    });
    clients.push(clientBad);

    await waitFor(() => decryptionErrors >= 1);
    expect(await fs.readFile(envBad, 'utf8')).toBe('LOCAL=untouched\n');
  });

  it('syncs offline local changes automatically upon reconnect', async () => {
    const roomId = 'E2E-ROOM-3';
    const key = deriveKey('offline-test-pass', roomId);

    const envA = path.join(tmpDir, 'offlineA.env');
    const envB = path.join(tmpDir, 'offlineB.env');

    await fs.writeFile(envA, 'STEP=1\n', 'utf8');

    const clientA = await startSyncClient({
      roomId,
      key,
      filePath: envA,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
      networkOptions: { baseReconnectDelayMs: 200, maxReconnectDelayMs: 500 },
    });
    clients.push(clientA);

    const clientB = await startSyncClient({
      roomId,
      key,
      filePath: envB,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientB);

    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'STEP=1\n');

    clientA.network.disconnect();
    await waitFor(() => !clientA.network.isConnected());

    await fs.writeFile(envA, 'STEP=2-OFFLINE\n', 'utf8');
    await waitFor(() => clientA.stateManager.hasPendingLocalChanges());

    clientA.network.connect();
    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'STEP=2-OFFLINE\n');
  });

  it('supports async offline teams via zero-trust relay cache, one-shot push/pull, and dry-run diff', async () => {
    const roomId = 'ASYNC-CACHE-1';
    const key = deriveKey('async-passphrase', roomId);

    const envSender = path.join(tmpDir, 'sender.env');
    const envReceiver = path.join(tmpDir, 'receiver.env');

    await fs.writeFile(envSender, 'PORT=3001\nAPI_TOKEN=secret_abc\nDB=pg\n', 'utf8');
    await fs.writeFile(envReceiver, 'PORT=4000\nDB=old_pg\n', 'utf8');

    // Sender pushes once (ignoring PORT) and disconnects completely
    const pushRes = await pushOnce({
      roomId,
      key,
      filePath: envSender,
      wsUrl: relay.url,
      ignoreKeys: ['PORT'],
    });
    expect(pushRes.keyCount).toBe(2);
    expect(relay.getStats().cachedRooms).toBe(1);
    expect(relay.getStats().clients).toBe(0);

    // Receiver previews diff (dryRun) while 0 other peers are online
    const diffRes = await pullOnce({
      roomId,
      key,
      filePath: envReceiver,
      wsUrl: relay.url,
      ignoreKeys: ['PORT'],
      dryRun: true,
    });
    expect(diffRes.received).toBe(true);
    expect(diffRes.applied).toBe(false);
    expect(diffRes.diffs.map((d) => `${d.kind}:${d.key}`)).toEqual([
      'added:API_TOKEN',
      'modified:DB',
    ]);
    // Dry run must not touch local file
    expect(await fs.readFile(envReceiver, 'utf8')).toBe('PORT=4000\nDB=old_pg\n');

    // Receiver pulls for real — merges API_TOKEN & DB while preserving local PORT=4000
    const pullRes = await pullOnce({
      roomId,
      key,
      filePath: envReceiver,
      wsUrl: relay.url,
      ignoreKeys: ['PORT'],
    });
    expect(pullRes.received).toBe(true);
    expect(pullRes.applied).toBe(true);
    expect(parseEnvValues(await fs.readFile(envReceiver, 'utf8'))).toEqual({
      PORT: '4000',
      DB: 'pg',
      API_TOKEN: 'secret_abc',
    });
  });

  it('merges concurrent edits to different keys between peers without data loss', async () => {
    const roomId = 'CRDT-MERGE-1';
    const key = deriveKey('crdt-passphrase', roomId);

    const envA = path.join(tmpDir, 'crdtA.env');
    const envB = path.join(tmpDir, 'crdtB.env');

    await fs.writeFile(envA, 'BASE=1\n', 'utf8');

    const clientA = await startSyncClient({
      roomId,
      key,
      filePath: envA,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientA);

    const clientB = await startSyncClient({
      roomId,
      key,
      filePath: envB,
      wsUrl: relay.url,
      silent: true,
      debounceMs: 50,
    });
    clients.push(clientB);

    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'BASE=1\n');

    // Disconnect B so A and B make concurrent offline edits to DIFFERENT keys
    clientB.network.disconnect();
    await waitFor(() => !clientB.network.isConnected());

    await fs.writeFile(envA, 'BASE=1\nFROM_A=alpha\n', 'utf8');
    await waitFor(() => 'FROM_A' in clientA.stateManager.getKeyState());

    await fs.writeFile(envB, 'BASE=1\nFROM_B=beta\n', 'utf8');
    await waitFor(() => clientB.stateManager.hasPendingLocalChanges());

    // Reconnect B — both A and B should converge to having BASE, FROM_A, AND FROM_B
    clientB.network.connect();

    await waitFor(async () => {
      const valsA = parseEnvValues(await fs.readFile(envA, 'utf8'));
      const valsB = parseEnvValues(await fs.readFile(envB, 'utf8'));
      return (
        valsA.FROM_A === 'alpha' &&
        valsA.FROM_B === 'beta' &&
        valsB.FROM_A === 'alpha' &&
        valsB.FROM_B === 'beta'
      );
    });
  });

  it('rotates room credentials, updates config, and pushes re-encrypted state to the new room', async () => {
    const projectDir = path.join(tmpDir, 'rotate-proj');
    await fs.mkdir(projectDir, { recursive: true });
    const envFile = path.join(projectDir, '.env');
    await fs.writeFile(envFile, 'ROTATED_SECRET=top-secret\n', 'utf8');

    const res = await rotateRoom({
      newPassphrase: 'brand-new-passphrase',
      filePath: envFile,
      wsUrl: relay.url,
      cwd: projectDir,
      profile: 'staging',
    });

    expect(res.pushed).toBe(true);
    expect(res.keyCount).toBe(1);

    const saved = loadConfig(projectDir, 'staging');
    expect(saved?.roomId).toBe(res.newRoomId);
    expect(saved?.passphrase).toBe('brand-new-passphrase');

    // Teammate joins the new room and pulls the rotated secret immediately
    const teammateEnv = path.join(tmpDir, 'teammate.env');
    const newKey = deriveKey('brand-new-passphrase', res.newRoomId);
    const pull = await pullOnce({
      roomId: res.newRoomId,
      key: newKey,
      filePath: teammateEnv,
      wsUrl: relay.url,
    });
    expect(pull.received).toBe(true);
    expect(pull.applied).toBe(true);
    expect(parseEnvValues(await fs.readFile(teammateEnv, 'utf8'))).toEqual({
      ROTATED_SECRET: 'top-secret',
    });
  });
});
