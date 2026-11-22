import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface LocalState {
  content: string;
  timestamp: number;
  created: boolean;
}

export type UpdateEvaluationResult =
  | {
      action: 'pushback';
      localContent: string;
      localTimestamp: number;
      reason: 'empty_overwrite' | 'local_newer';
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
  private lastKnownContent = '';
  private lastKnownTimestamp = 0;
  private pendingLocalChanges = false;
  private initialized = false;

  constructor(filePath = '.env') {
    this.filePath = filePath;
  }

  public hasPendingLocalChanges(): boolean {
    return this.pendingLocalChanges;
  }

  public clearPendingLocalChanges(): void {
    this.pendingLocalChanges = false;
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
    } else if (this.initialized && content === this.lastKnownContent && this.lastKnownTimestamp > 0) {
      timestamp = Math.max(this.lastKnownTimestamp, mtimeMs);
    } else {
      timestamp = mtimeMs;
    }

    if (!this.initialized) {
      this.lastKnownContent = content;
      this.lastKnownTimestamp = timestamp;
      this.initialized = true;
    }

    return { content, timestamp, created };
  }

  /**
   * Evaluates an incoming decrypted update using LWW timestamps and
   * empty-overwrite protection. Performs atomic writes when applying updates.
   */
  public async evaluateUpdate(
    incomingContent: string,
    incomingTimestampRaw?: number,
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

    const localIsEmpty = localContent.trim() === '';
    const incomingIsEmpty = incomingContent.trim() === '';

    // Identical content: no write needed, sync logical clock to avoid ping-pong
    if (incomingContent === localContent) {
      this.lastKnownContent = incomingContent;
      this.lastKnownTimestamp = Math.max(this.lastKnownTimestamp, incomingTimestamp);
      this.pendingLocalChanges = false;
      return { action: 'ignored', reason: 'identical' };
    }

    // Empty-overwrite protection: never let an empty payload wipe a populated local file
    if (incomingIsEmpty && !localIsEmpty) {
      const effectiveLocalTs = Math.max(this.lastKnownTimestamp, localMtimeMs, 1);
      return {
        action: 'pushback',
        localContent,
        localTimestamp: effectiveLocalTs,
        reason: 'empty_overwrite',
      };
    }

    // Effective local timestamp is 0 when local file is empty (cold start)
    const effectiveLocalTimestamp = localIsEmpty
      ? 0
      : Math.max(this.lastKnownTimestamp, localMtimeMs);

    // LWW Footrace check: if local is strictly newer than incoming, push back
    if (incomingTimestamp > 0 && effectiveLocalTimestamp > incomingTimestamp) {
      return {
        action: 'pushback',
        localContent,
        localTimestamp: effectiveLocalTimestamp,
        reason: 'local_newer',
      };
    }

    // Apply remote update atomically, updating tracker BEFORE writing to suppress watcher echo
    this.lastKnownContent = incomingContent;
    this.lastKnownTimestamp = incomingTimestamp > 0 ? incomingTimestamp : Date.now();
    this.pendingLocalChanges = false;
    this.initialized = true;

    await this.writeAtomic(incomingContent, this.lastKnownTimestamp);
    return { action: 'updated' };
  }

  /**
   * Tracks a local file edit from the watcher. Returns null if the content
   * matches our last known state (echo suppression), otherwise returns the
   * new authoritative timestamp.
   */
  public trackLocalUpdate(fileContent: string, isOffline = false): number | null {
    if (this.initialized && fileContent === this.lastKnownContent) {
      return null;
    }
    const now = Date.now();
    this.lastKnownContent = fileContent;
    this.lastKnownTimestamp = fileContent.trim() === '' ? 0 : now;
    this.initialized = true;
    if (isOffline) {
      this.pendingLocalChanges = true;
    }
    return this.lastKnownTimestamp;
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
