import chokidar from 'chokidar';
import fs from 'fs';

export function startWatching(callback) {
  let debounceTimer;

  // Watch the .env file in the current directory
  chokidar.watch('.env', { 
    persistent: true,
    awaitWriteFinish: { // Chokidar has a built-in debounce for this exact issue!
      stabilityThreshold: 300,
      pollInterval: 100
    }
  }).on('change', () => {
    
    clearTimeout(debounceTimer);
    
    // Custom debounce to be extra safe against VS Code's rapid saves
    debounceTimer = setTimeout(() => {
      try {
        const fileContent = fs.readFileSync('.env', 'utf8');
        callback(fileContent);
      } catch (error) {
        console.error('Error reading .env file:', error);
      }
    }, 300); // Wait 300ms after the last change before triggering

  });
}