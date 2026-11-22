import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type KeyStateMap,
  mergeEnvStates,
  stripIgnoredKeys,
  updateKeyStateMap,
} from './envMerge.js';

export interface LocalState {
  content: string;
  /** Content with ignoreKeys stripped, safe to encrypt and send to peers. */
  broadcastContent: string;
  timestamp: number;
  keys: KeyStateMap;
  created: boolean;
}

export type UpdateEvaluationResult =
  | {
      action: 'pushback';
      localContent: string;
      localKeys: KeyStateMap;
      localTimestamp: number;
      reason: 'empty_overwrite' | 'local_newer' | 'merged_conflict';
      updatedLocal?: boolean;
    }
  | {
      action: 'ignored';
      reason: 'identical';
    }
  | {
      action: 'updated';
    };

export class StateManager {
  public readonly filePath: string;
  public readonly ignoreKeys: readonly string[];
  private lastKnownContent = '';
  private lastKnownTimestamp = 0;
  private keyState: KeyStateMap = {};
  private pendingLocalChanges = false;
  private initialized = false;

  constructor(filePath = '.env', ignoreKeys: readonly string[] = []) {
    this.filePath = filePath;
    this.ignoreKeys = [...ignoreKeys];
  }

  public hasPendingLocalChanges(): boolean {
    return this.pendingLocalChanges;
  }

  public clearPendingLocalChanges(): void {
    this.pendingLocalChanges = false;
  }

  public getKeyState(): KeyStateMap {
    return { ...this.keyState };
  }

  public async ensureFileExists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return false;
    } catch {
      const dir = path.dirname(this.filePath);
      if (dir && dir !== '.') {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(this.filePath, '', { encoding: 'utf8', mode: 0o600 });
      return true;
    }
  }

  /**
   * Reads the local file state. On cold start (file newly created or empty),
   * uses timestamp 0 so any non-empty remote peer state wins cleanly.
   */
  public async getLocalState(): Promise<LocalState> {
    const created = await this.ensureFileExists();
    const [stats, content] = await Promise.all([
      fs.stat(this.filePath),
      fs.readFile(this.filePath, 'utf8'),
    ]);

    const mtimeMs = Math.floor(stats.mtimeMs);
    let timestamp: number;

    if (created || content.trim() === '') {
      timestamp = 0;
    } else if (
      this.initialized &&
      content === this.lastKnownContent &&
      this.lastKnownTimestamp > 0
    ) {
      timestamp = Math.max(this.lastKnownTimestamp, mtimeMs);
    } else {
      timestamp = mtimeMs;
    }

    if (!this.initialized) {
      this.lastKnownContent = content;
      this.lastKnownTimestamp = timestamp;
      this.keyState = updateKeyStateMap({}, content, timestamp, this.ignoreKeys);
      this.initialized = true;
    } else if (content !== this.lastKnownContent) {
      this.lastKnownContent = content;
      this.lastKnownTimestamp = timestamp;
      this.keyState = updateKeyStateMap(this.keyState, content, timestamp, this.ignoreKeys);
    }

    return {
      content,
      broadcastContent: stripIgnoredKeys(content, this.ignoreKeys),
      timestamp,
      keys: { ...this.keyState },
      created,
    };
  }

  /**
   * Evaluates an incoming decrypted update using per-key LWW CRDT merge (v2)
   * or whole-file LWW fallback (v1), while protecting against empty overwrites
   * and preserving local ignoreKeys.
   */
  public async evaluateUpdate(
    incomingContent: string,
    incomingTimestampRaw?: number,
    incomingKeys?: KeyStateMap,
  ): Promise<UpdateEvaluationResult> {
    const incomingTimestamp =
      typeof incomingTimestampRaw === 'number' && Number.isFinite(incomingTimestampRaw)
        ? Math.floor(incomingTimestampRaw)
        : 0;

    let localContent = '';
    let localMtimeMs = 0;
    try {
      const [stats, content] = await Promise.all([
        fs.stat(this.filePath),
        fs.readFile(this.filePath, 'utf8'),
      ]);
      localMtimeMs = Math.floor(stats.mtimeMs);
      localContent = content;
    } catch {
      // File may not exist yet
    }

    const localBroadcastContent = stripIgnoredKeys(localContent, this.ignoreKeys);
    const localIsEmpty = localBroadcastContent.trim() === '';
    const incomingIsEmpty = incomingContent.trim() === '';

    // Empty-overwrite protection: never let an empty payload wipe a populated local file
    if (incomingIsEmpty && !localIsEmpty) {
      const effectiveLocalTs = Math.max(this.lastKnownTimestamp, localMtimeMs, 1);
      const localKeys = this.initialized
        ? { ...this.keyState }
        : updateKeyStateMap({}, localContent, effectiveLocalTs, this.ignoreKeys);
      return {
        action: 'pushback',
        localContent: localBroadcastContent,
        localKeys,
        localTimestamp: effectiveLocalTs,
        reason: 'empty_overwrite',
      };
    }

    // Use key-level LWW CRDT merge when v2 key metadata is present or ignoreKeys are configured
    if (incomingKeys || this.ignoreKeys.length > 0) {
      const effectiveLocalTs = localIsEmpty
        ? 0
        : Math.max(this.lastKnownTimestamp, localMtimeMs);
      const currentLocalKeys = this.initialized
        ? this.keyState
        : updateKeyStateMap({}, localContent, effectiveLocalTs, this.ignoreKeys);
      const remoteKeys =
        incomingKeys ??
        updateKeyStateMap({}, incomingContent, incomingTimestamp, this.ignoreKeys);

      const merge = mergeEnvStates({
        localContent,
        localKeys: currentLocalKeys,
        remoteContent: incomingContent,
        remoteKeys,
        ignoreKeys: this.ignoreKeys,
      });

      this.keyState = merge.mergedKeys;
      const mergedTs = Math.max(effectiveLocalTs, incomingTimestamp, Date.now());
      this.initialized = true;

      if (merge.changedLocal) {
        this.lastKnownContent = merge.mergedContent;
        this.lastKnownTimestamp = mergedTs;
        this.pendingLocalChanges = false;
        await this.writeAtomic(merge.mergedContent, mergedTs);
      }

      if (merge.localHasNewerKeys) {
        return {
          action: 'pushback',
          localContent: stripIgnoredKeys(merge.mergedContent, this.ignoreKeys),
          localKeys: { ...this.keyState },
          localTimestamp: mergedTs,
          reason: merge.changedLocal ? 'merged_conflict' : 'local_newer',
          updatedLocal: merge.changedLocal,
        };
      }

      if (merge.changedLocal) {
        return { action: 'updated' };
      }

      return { action: 'ignored', reason: 'identical' };
    }

    // Legacy v1 whole-file LWW path (no incomingKeys and no ignoreKeys)
    if (incomingContent === localContent) {
      this.lastKnownContent = incomingContent;
      this.lastKnownTimestamp = Math.max(this.lastKnownTimestamp, incomingTimestamp);
      this.pendingLocalChanges = false;
      return { action: 'ignored', reason: 'identical' };
    }

    const effectiveLocalTimestamp = localIsEmpty
      ? 0
      : Math.max(this.lastKnownTimestamp, localMtimeMs);

    if (incomingTimestamp > 0 && effectiveLocalTimestamp > incomingTimestamp) {
      return {
        action: 'pushback',
        localContent: localBroadcastContent,
        localKeys: { ...this.keyState },
        localTimestamp: effectiveLocalTimestamp,
        reason: 'local_newer',
      };
    }

    const nextTs = incomingTimestamp > 0 ? incomingTimestamp : Date.now();
    this.lastKnownContent = incomingContent;
    this.lastKnownTimestamp = nextTs;
    this.keyState = updateKeyStateMap(this.keyState, incomingContent, nextTs, this.ignoreKeys);
    this.pendingLocalChanges = false;
    this.initialized = true;

    await this.writeAtomic(incomingContent, nextTs);
    return { action: 'updated' };
  }

  /**
   * Tracks a local file edit from the watcher. Returns null if the content
   * matches our last known state (echo suppression), otherwise returns the
   * new authoritative timestamp and updated per-key metadata.
   */
  public trackLocalUpdate(
    fileContent: string,
    isOffline = false,
  ): { timestamp: number; broadcastContent: string; keys: KeyStateMap } | null {
    if (this.initialized && fileContent === this.lastKnownContent) {
      return null;
    }

    const prevBroadcast = stripIgnoredKeys(this.lastKnownContent, this.ignoreKeys);
    const nextBroadcast = stripIgnoredKeys(fileContent, this.ignoreKeys);

    const now = Date.now();
    this.lastKnownContent = fileContent;
    this.initialized = true;

    // If only ignored keys changed locally, update local tracker without broadcasting
    if (nextBroadcast === prevBroadcast && Object.keys(this.keyState).length > 0) {
      return null;
    }

    this.lastKnownTimestamp = nextBroadcast.trim() === '' ? 0 : now;
    this.keyState = updateKeyStateMap(
      this.keyState,
      fileContent,
      this.lastKnownTimestamp || now,
      this.ignoreKeys,
    );

    if (isOffline) {
      this.pendingLocalChanges = true;
    }

    return {
      timestamp: this.lastKnownTimestamp,
      broadcastContent: nextBroadcast,
      keys: { ...this.keyState },
    };
  }

  private async writeAtomic(content: string, timestampMs: number): Promise<void> {
    const dir = path.dirname(this.filePath) || '.';
    const base = path.basename(this.filePath);
    const tmpPath = path.join(
      dir,
      `.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );

    await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      const timeSec = timestampMs / 1000;
      await fs.utimes(tmpPath, timeSec, timeSec);
    } catch {
      // Setting mtime is best-effort
    }
    await fs.rename(tmpPath, this.filePath);
  }
}
