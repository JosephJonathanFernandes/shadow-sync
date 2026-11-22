import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveKey } from '../src/crypto.js';
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

  it('serves /health with live room and client counts', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; rooms: number; clients: number };
    expect(body).toEqual({ status: 'ok', rooms: 0, clients: 0 });
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

    // Peer B should automatically receive Peer A's initial .env
    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'INITIAL=fromA\n');

    // Now Peer A edits its .env — Peer B should receive the live update
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

    // Disconnect clientA, make an offline edit, then reconnect
    clientA.network.disconnect();
    await waitFor(() => !clientA.network.isConnected());

    await fs.writeFile(envA, 'STEP=2-OFFLINE\n', 'utf8');
    await waitFor(() => clientA.stateManager.hasPendingLocalChanges());

    // Reconnect clientA — its offline change should immediately sync to clientB
    clientA.network.connect();
    await waitFor(async () => (await fs.readFile(envB, 'utf8')) === 'STEP=2-OFFLINE\n');
  });
});
