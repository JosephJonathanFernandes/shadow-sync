import { program } from 'commander';
import chalk from 'chalk';
import * as readline from 'readline';
import { saveConfig, loadConfig } from './config.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

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
    const passphrase = await askQuestion('Enter a passphrase for the room: ');
    const roomId = generateRoomId();
    
    if (saveConfig(roomId, passphrase)) {
      console.log(chalk.green(`✔ Room created successfully!`));
      console.log(chalk.blue(`ℹ Room ID: ${roomId}`));
    }
    rl.close();
  });

program
  .command('join <roomId>')
  .description('Join an existing shadow-sync room')
  .action(async (roomId) => {
    const passphrase = await askQuestion('Enter the passphrase for the room: ');
    
    if (saveConfig(roomId, passphrase)) {
      console.log(chalk.green(`✔ Joined room ${roomId} successfully!`));
    }
    rl.close();
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
    rl.close();
  });

program.parse(process.argv);
