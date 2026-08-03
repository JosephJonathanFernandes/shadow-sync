import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import { encryptEnv, decryptEnv } from './crypto.js';
import { startWatching } from './watcher.js';

let ws;
// Replace the boolean flag with a string tracker
let lastKnownContent = ''; 

export function initSyncServer({ roomId, key, mode }) {
  const wsUrl = process.env.SYNC_WS_URL || 'ws://shadow-sync.onrender.com';
  
  const spinner = ora(`Connecting to Sync Server...`).start();

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    spinner.succeed(chalk.green(`Connected to Sync Server: ${wsUrl}`));
    
    // Join room
    ws.send(JSON.stringify({ type: 'join', roomId }));
    console.log(chalk.cyan(`Joined room: ${roomId}`));

    // Set up file watcher
    startWatching(async (fileContent) => {
      // THE FIX: If the text hasn't actually changed, it's just a ghost echo. Ignore it!
      if (fileContent === lastKnownContent) return;
      
      // It's a genuine new change, so update our tracker
      lastKnownContent = fileContent;
      
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

  ws.on('message', async (messageAsString) => {
    try {
      const parsedMessage = JSON.parse(messageAsString);

      if (parsedMessage.type === 'update') {
        const encryptedPayload = parsedMessage.payload;
        const decryptedContent = decryptEnv(encryptedPayload, key);

        // THE FIX: If what we just received is identical to what we already have, ignore it!
        if (decryptedContent === lastKnownContent) return;

        // Update our tracker BEFORE writing to the file
        lastKnownContent = decryptedContent;

        await fs.writeFile('.env', decryptedContent, 'utf8');

        console.log(chalk.green('↓ Received and applied remote update.'));
      }
    } catch (error) {
      console.error(chalk.red('[-] Error processing incoming message:'), error);
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