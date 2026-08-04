import WebSocket from 'ws';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import { encryptEnv, decryptEnv } from './crypto.js';
import { startWatching } from './watcher.js';

let ws;
// Replace the boolean flag with a string tracker
let lastKnownContent = ''; 

export async function initSyncServer({ roomId, key, mode }) {
  try {
    await fs.access('.env');
  } catch {
    await fs.writeFile('.env', '', 'utf8');
    console.log(chalk.yellow('Created empty .env file for cold start.'));
  }

  const wsUrl = process.env.SYNC_WS_URL || 'wss://shadow-sync.onrender.com';
  let isWatching = false;
  let reconnectTimer;
  let isOffline = false;
  let pingInterval;
  let pingTimeout;
  
  // Set up file watcher immediately so Node event loop doesn't exit if connection fails
  startWatching(async (fileContent) => {
    // THE FIX: If the text hasn't actually changed, it's just a ghost echo. Ignore it!
    if (fileContent === lastKnownContent) return;
    
    // It's a genuine new change, so update our tracker
    lastKnownContent = fileContent;
    
    const syncSpinner = ora('Encrypting and syncing changes...').start();
    try {
      const encrypted = encryptEnv(fileContent, key);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'sync',
          roomId,
          payload: encrypted,
          timestamp: Date.now()
        }));
        syncSpinner.succeed(chalk.green('Changes synced successfully!'));
      } else {
        syncSpinner.fail(chalk.red('WebSocket is not open.'));
      }
    } catch (err) {
      syncSpinner.fail(chalk.red('Failed to sync changes.'));
      console.error(err);
    }
  });
  
  function connect() {
    clearTimeout(reconnectTimer);
    clearInterval(pingInterval);
    clearTimeout(pingTimeout);
    
    let spinner;
    if (!isOffline) {
      spinner = ora(`Connecting to Sync Server...`).start();
    }
  
    ws = new WebSocket(wsUrl);
  
    ws.on('open', () => {
      isOffline = false;
      if (spinner) {
        spinner.succeed(chalk.green(`Connected to Sync Server: ${wsUrl}`));
      } else {
        console.log(chalk.green(`✔ Reconnected to Sync Server: ${wsUrl}`));
      }
      
      // Join room
      ws.send(JSON.stringify({ type: 'join', roomId }));
      console.log(chalk.cyan(`Joined room: ${roomId}`));
      
      // Request current state from existing clients in the room
      ws.send(JSON.stringify({ type: 'request_state', roomId }));

      // Setup Heartbeat
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          pingTimeout = setTimeout(() => {
            console.log(chalk.red('[-] Heartbeat failed. Terminating zombie connection...'));
            ws.terminate();
          }, 5000);
        }
      }, 5000);
    });

    ws.on('pong', () => {
      clearTimeout(pingTimeout);
    });
  
    ws.on('message', async (messageAsString) => {
      try {
        const parsedMessage = JSON.parse(messageAsString);
  
        if (parsedMessage.type === 'request_state') {
          try {
            const stats = await fs.stat('.env');
            const fileContent = await fs.readFile('.env', 'utf8');
            const encrypted = encryptEnv(fileContent, key);
            ws.send(JSON.stringify({
              type: 'sync',
              roomId,
              payload: encrypted,
              timestamp: stats.mtimeMs
            }));
            console.log(chalk.cyan('↑ Synced local state to teammate.'));
          } catch (err) {
            if (err.code === 'ENOENT') {
              await fs.writeFile('.env', '', 'utf8');
              const encrypted = encryptEnv('', key);
              ws.send(JSON.stringify({
                type: 'sync',
                roomId,
                payload: encrypted,
                timestamp: Date.now()
              }));
              console.log(chalk.cyan('↑ Created empty .env and synced state to late joiner.'));
            } else {
              console.error(chalk.red('[-] Error reading .env for state request:'), err);
            }
          }
        } else if (parsedMessage.type === 'update') {
          const encryptedPayload = parsedMessage.payload;
          const decryptedContent = decryptEnv(encryptedPayload, key);
          const incomingTimestamp = parsedMessage.timestamp;
          
          let localContent = '';
          let localMtimeMs = 0;
          try {
            const stats = await fs.stat('.env');
            localMtimeMs = stats.mtimeMs;
            localContent = await fs.readFile('.env', 'utf8');
          } catch (e) {
            // File might not exist
          }

          // Empty Overwrites Check
          if (decryptedContent.trim() === '' && localContent.trim() !== '') {
            console.log(chalk.yellow('⚠ Refusing to overwrite local .env with empty sync. Pushing local changes back...'));
            ws.send(JSON.stringify({
              type: 'sync',
              roomId,
              payload: encryptEnv(localContent, key),
              timestamp: Date.now()
            }));
            return;
          }

          // The Footrace Check
          if (incomingTimestamp && localMtimeMs > incomingTimestamp) {
            console.log(chalk.yellow('⚠ Local .env is newer than incoming sync. Pushing local changes back...'));
            ws.send(JSON.stringify({
              type: 'sync',
              roomId,
              payload: encryptEnv(localContent, key),
              timestamp: Date.now()
            }));
            return;
          }
  
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
      if (!isOffline) {
        if (spinner && spinner.isSpinning) {
          spinner.fail(chalk.red('WebSocket error.'));
        }
        console.error(chalk.red(`[-] WebSocket encountered an error: ${err.message || err}`));
      }
    });
    
    ws.on('close', () => {
      clearInterval(pingInterval);
      clearTimeout(pingTimeout);
      
      if (!isOffline) {
        isOffline = true;
        if (spinner && spinner.isSpinning) {
          spinner.stop();
        }
        console.log(chalk.yellow('[-] Connection lost. Reconnecting in background...'));
      }
      
      reconnectTimer = setTimeout(connect, 3000);
    });
  }

  connect();
}