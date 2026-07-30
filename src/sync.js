import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { encryptEnv, decryptEnv } from './crypto.js';
import { startWatching } from './watcher.js';

let ws;
let isUpdatingLocal = false; // Flag to prevent recursive loops

export function initSyncServer({ roomId, key, mode }) {
  const wsUrl = process.env.SYNC_WS_URL || 'wss://ws.postman-echo.com/raw';
  
  const spinner = ora(`Connecting to Sync Server...`).start();

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    spinner.succeed(chalk.green(`Connected to Sync Server: ${wsUrl}`));
    
    // Join room
    ws.send(JSON.stringify({ type: 'join', roomId }));
    
    console.log(chalk.cyan(`Joined room: ${roomId}`));

    // Set up file watcher
    startWatching(async (fileContent) => {
      if (isUpdatingLocal) return; // Prevent echoing back what we just received
      
      const syncSpinner = ora('Encrypting and syncing changes...').start();
      try {
        const encrypted = encryptEnv(fileContent, key);
        ws.send(JSON.stringify({
          type: 'sync',
          roomId,
          payload: encrypted
        }));
        syncSpinner.succeed(chalk.green('Changes synced successfully!'));
      } catch (err) {
        syncSpinner.fail(chalk.red('Failed to sync changes.'));
        console.error(err);
      }
    });
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'sync' && message.roomId === roomId && message.payload) {
        const recvSpinner = ora('Receiving and decrypting changes...').start();
        try {
          const decrypted = decryptEnv(message.payload, key);
          
          isUpdatingLocal = true;
          const envPath = path.resolve(process.cwd(), '.env');
          await fs.writeFile(envPath, decrypted, 'utf-8');
          
          // Reset flag after a short delay to allow chokidar events to fire and be ignored
          setTimeout(() => {
            isUpdatingLocal = false;
          }, 1000);
          
          recvSpinner.succeed(chalk.green('Local .env updated successfully!'));
        } catch (err) {
          recvSpinner.fail(chalk.red('Failed to decrypt or apply changes.'));
          console.error(chalk.red(err.message));
        }
      }
    } catch (err) {
      // Ignore messages that are not JSON or lack expected fields
    }
  });

  ws.on('error', (err) => {
    spinner.fail(chalk.red('WebSocket error.'));
    console.error(err);
  });
  
  ws.on('close', () => {
    console.log(chalk.yellow('Disconnected from Sync Server.'));
  });
}
