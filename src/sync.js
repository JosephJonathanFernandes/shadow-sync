import chalk from 'chalk';
import ora from 'ora';
import { encryptEnv, decryptEnv } from './crypto.js';
import { startWatching } from './watcher.js';
import { NetworkManager } from './NetworkManager.js';
import { StateManager } from './StateManager.js';

export async function initSyncServer({ roomId, key, mode }) {
  const stateManager = new StateManager('.env');
  
  const { created } = await stateManager.getLocalState();
  if (created) {
    console.log(chalk.yellow('Created empty .env file for cold start.'));
  }

  const wsUrl = process.env.SYNC_WS_URL || 'wss://shadow-sync.onrender.com';
  
  const network = new NetworkManager(wsUrl, roomId);
  let spinner = ora(`Connecting to Sync Server...`).start();
  let isOffline = false;
  
  // Set up file watcher immediately so Node event loop doesn't exit if connection fails
  startWatching((fileContent) => {
    if (!stateManager.checkAndTrackLocalUpdate(fileContent)) return;
    
    if (!network.isConnected()) {
      console.log(chalk.red('Offline: Changes saved locally and will sync when reconnected'));
      return;
    }

    const syncSpinner = ora('Encrypting and syncing changes...').start();
    try {
      const encrypted = encryptEnv(fileContent, key);
      network.send({
        type: 'sync',
        roomId,
        payload: encrypted,
        timestamp: Date.now()
      });
      syncSpinner.succeed(chalk.green('Changes synced successfully!'));
    } catch (err) {
      syncSpinner.fail(chalk.red('Failed to sync changes.'));
      console.error(err);
    }
  });

  network.on('connected', () => {
    isOffline = false;
    if (spinner) {
      spinner.succeed(chalk.green(`Connected to Sync Server: ${wsUrl}`));
      spinner = null;
    } else {
      console.log(chalk.green(`✔ Reconnected to Sync Server: ${wsUrl}`));
    }
    console.log(chalk.cyan(`Joined room: ${roomId}`));
  });

  network.on('disconnected', (wasOffline) => {
    if (!wasOffline) {
      isOffline = true;
      if (spinner && spinner.isSpinning) {
        spinner.stop();
      }
      console.log(chalk.yellow('[-] Connection lost. Reconnecting in background...'));
    }
  });

  network.on('error', (err) => {
    if (!isOffline) {
      if (spinner && spinner.isSpinning) {
        spinner.fail(chalk.red('WebSocket error.'));
        spinner = null;
      }
      console.error(chalk.red(`[-] Network error: ${err.message || err}`));
    }
  });

  network.on('message', async (parsedMessage) => {
    try {
      if (parsedMessage.type === 'request_state') {
        const { content, timestamp, created } = await stateManager.getLocalState();
        const encrypted = encryptEnv(content, key);
        network.send({
          type: 'sync',
          roomId,
          payload: encrypted,
          timestamp
        });
        
        if (created) {
          console.log(chalk.cyan('↑ Created empty .env and synced state to late joiner.'));
        } else {
          console.log(chalk.cyan('↑ Synced local state to teammate.'));
        }
      } else if (parsedMessage.type === 'update') {
        const encryptedPayload = parsedMessage.payload;
        const decryptedContent = decryptEnv(encryptedPayload, key);
        const incomingTimestamp = parsedMessage.timestamp;
        
        const result = await stateManager.evaluateUpdate(decryptedContent, incomingTimestamp);

        if (result.action === 'pushback') {
          if (result.reason === 'empty_overwrite') {
            console.log(chalk.yellow('⚠ Refusing to overwrite local .env with empty sync. Pushing local changes back...'));
          } else if (result.reason === 'footrace') {
            console.log(chalk.yellow('⚠ Local .env is newer than incoming sync. Pushing local changes back...'));
          }
          
          network.send({
            type: 'sync',
            roomId,
            payload: encryptEnv(result.localContent, key),
            timestamp: result.localTimestamp || Date.now()
          });
        } else if (result.action === 'updated') {
          console.log(chalk.green('↓ Received and applied remote update.'));
        }
      }
    } catch (error) {
      console.error(chalk.red('[-] Error processing incoming message:'), error);
    }
  });

  network.connect();
}