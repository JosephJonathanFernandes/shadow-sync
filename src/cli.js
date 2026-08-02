import { program } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { saveConfig, loadConfig } from './config.js';
import { initSyncServer } from './sync.js';
import { deriveKey } from './crypto.js';

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

program
  .name('shadow-sync')
  .description('Real-time, zero-trust E2E encrypted environment variable synchronizer')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize a new shadow-sync room')
  .action(async () => {
    // Swapped readline for inquirer to get the ****** mask
    const { passphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Enter a passphrase for the room:',
        mask: '*'
      }
    ]);
    
    const roomId = generateRoomId();
    
    if (saveConfig(roomId, passphrase)) {
      console.log(chalk.green(`✔ Room created successfully!`));
      console.log(chalk.blue(`ℹ Room ID: ${roomId}`));
    }
  });

program
  .command('join <roomId>')
  .description('Join an existing shadow-sync room')
  .action(async (roomId) => {
    // Swapped readline for inquirer here too
    const { passphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Enter the passphrase for the room:',
        mask: '*'
      }
    ]);
    
    if (saveConfig(roomId, passphrase)) {
      console.log(chalk.green(`✔ Joined room ${roomId} successfully!`));
    }
  });

program
  .command('watch')
  .description('Start watching for changes')
  .action(() => {
    const config = loadConfig();
    if (!config) {
      console.error(chalk.red('✖ No configuration found. Please run "shadow-sync init" or "shadow-sync join <roomId>" first.'));
      process.exit(1);
    }
    
    console.log(chalk.green('✔ Watcher is ready. Configuration verified.'));
    
    try {
      // Actually start the engine! This keeps the terminal alive.
      const key = deriveKey(config.passphrase, config.roomId);
      initSyncServer({ roomId: config.roomId, key, mode: 'sync' });
    } catch (error) {
      console.error(chalk.red(`✖ Failed to start watcher: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('start [roomId]')
  .description('Start the shadow-sync server for a room')
  .action(async (roomId) => {
    if (!roomId) {
      console.error(chalk.red('✖ Error: Missing roomId. Please provide a roomId to start.'));
      console.log(chalk.yellow('Usage: shadow-sync start <roomId>'));
      process.exit(1);
    }
    
    const { passphrase } = await inquirer.prompt([
      {
        type: 'password',
        name: 'passphrase',
        message: 'Enter the room passphrase:',
        mask: '*'
      }
    ]);

    try {
      const key = deriveKey(passphrase, roomId);
      initSyncServer({ roomId, key, mode: 'sync' });
    } catch (error) {
      console.error(chalk.red(`✖ Failed to start server: ${error.message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);