import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';

let timeout = null;

export function startWatching(onFileChange) {
  const envPath = path.resolve(process.cwd(), '.env');

  // Simplified watcher: just watch the exact file path
  const watcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true,
    // awaitWriteFinish is great for Windows to ensure the file is fully saved before reading
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on('change', async (filePath) => {
    // 300ms debounce to avoid duplicate events on fast saves
    if (timeout) {
      clearTimeout(timeout);
    }
    
    timeout = setTimeout(async () => {
      try {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        onFileChange(fileContent);
      } catch (err) {
        // Ignore read errors from temporary locking by editors
        if (err.code !== 'EBUSY' && err.code !== 'ENOENT') {
          console.error(`Error reading ${filePath}:`, err);
        }
      }
    }, 300);
  });

  return watcher;
}