import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs/promises';

export interface WatcherOptions {
  filePath?: string;
  debounceMs?: number;
  onError?: (error: Error) => void;
}

export interface FileWatcherHandle {
  close: () => Promise<void>;
}

/**
 * Watches a target .env file for modifications and creations, debouncing
 * rapid editor saves (e.g. VS Code atomic write/rename).
 */
export function startWatching(
  callback: (fileContent: string) => void | Promise<void>,
  options: WatcherOptions = {},
): FileWatcherHandle {
  const filePath = options.filePath ?? '.env';
  const debounceMs = options.debounceMs ?? 250;
  let debounceTimer: NodeJS.Timeout | null = null;

  const watcher: FSWatcher = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50,
    },
  });

  const handleEvent = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        const content = await fs.readFile(filePath, 'utf8');
        await callback(content);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (options.onError) {
          options.onError(err);
        }
      }
    }, debounceMs);
  };

  watcher.on('change', handleEvent);
  watcher.on('add', handleEvent);
  watcher.on('error', (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (options.onError) {
      options.onError(err);
    }
  });

  return {
    close: async () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}
