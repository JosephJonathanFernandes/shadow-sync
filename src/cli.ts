#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { program } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  CONFIG_FILE,
  PASSPHRASE_ENV_VAR,
  SERVER_URL_ENV_VAR,
  isGitignoreProtected,
  loadConfig,
  resolvePassphrase,
  saveConfig,
} from './config.js';
import { deriveKey, generateRoomId } from './crypto.js';
import { DEFAULT_RELAY_URL, isValidRoomId } from './protocol.js';
import { createRelayServer } from './server.js';
import { startSyncClient } from './sync.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

async function promptPassphrase(message: string, confirm = false): Promise<string> {
  const { passphrase } = await inquirer.prompt<{ passphrase: string }>([
    {
      type: 'password',
      name: 'passphrase',
      message,
      mask: '*',
      validate: (input: string) =>
        input.length >= 1 || 'Passphrase cannot be empty.',
    },
  ]);

  if (confirm) {
    const { confirmPassphrase } = await inquirer.prompt<{ confirmPassphrase: string }>([
      {
        type: 'password',
        name: 'confirmPassphrase',
        message: 'Confirm passphrase:',
        mask: '*',
        validate: (input: string) =>
          input === passphrase || 'Passphrases do not match.',
      },
    ]);
    if (confirmPassphrase !== passphrase) {
      throw new Error('Passphrases do not match.');
    }
  }

  return passphrase;
}

function registerGracefulShutdown(cleanup: () => Promise<void>): void {
  let shuttingDown = false;
  const handler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.yellow('\nShutting down cleanly...'));
    try {
      await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

program
  .name('env-sync')
  .description('Real-time, zero-trust E2E encrypted environment variable synchronizer')
  .version(pkg.version);

program
  .command('init')
  .description('Initialize a new shadow-sync room in the current directory')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .option(
    '--no-save-passphrase',
    `Do not store passphrase in ${CONFIG_FILE} (prompt or use ${PASSPHRASE_ENV_VAR})`,
  )
  .action(
    async (opts: { file: string; url?: string; savePassphrase: boolean }) => {
      try {
        const passphrase =
          process.env[PASSPHRASE_ENV_VAR] ||
          (await promptPassphrase('Enter a passphrase for the room:', true));

        const roomId = generateRoomId();
        const result = saveConfig(roomId, passphrase, {
          savePassphrase: opts.savePassphrase,
          file: opts.file,
          serverUrl: opts.url,
        });

        console.log(chalk.green('✔ Room created successfully!'));
        console.log(chalk.blue(`ℹ Room ID: ${chalk.bold(roomId)}`));
        console.log(chalk.dim(`  Config saved to ${result.configPath} (mode 0600)`));

        if (result.gitignoreCreated) {
          console.log(chalk.blue(`ℹ Created .gitignore and added ${CONFIG_FILE}`));
        } else if (result.gitignoreUpdated) {
          console.log(chalk.blue(`ℹ Added ${CONFIG_FILE} to .gitignore`));
        }

        if (!opts.savePassphrase) {
          console.log(
            chalk.yellow(
              `ℹ Passphrase was not written to disk. Set ${PASSPHRASE_ENV_VAR} or enter it when running "env-sync watch".`,
            ),
          );
        }

        console.log(chalk.dim('\nNext step: run "env-sync watch" to start syncing.'));
      } catch (error) {
        console.error(
          chalk.red(`✖ Failed to initialize room: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    },
  );

program
  .command('join <roomId>')
  .description('Join an existing shadow-sync room')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .option(
    '--no-save-passphrase',
    `Do not store passphrase in ${CONFIG_FILE} (prompt or use ${PASSPHRASE_ENV_VAR})`,
  )
  .action(
    async (
      roomId: string,
      opts: { file: string; url?: string; savePassphrase: boolean },
    ) => {
      if (!isValidRoomId(roomId)) {
        console.error(
          chalk.red('✖ Invalid Room ID. Use 3-64 alphanumeric, dash, or underscore characters.'),
        );
        process.exit(1);
      }

      try {
        const passphrase =
          process.env[PASSPHRASE_ENV_VAR] ||
          (await promptPassphrase('Enter the passphrase for the room:'));

        const result = saveConfig(roomId, passphrase, {
          savePassphrase: opts.savePassphrase,
          file: opts.file,
          serverUrl: opts.url,
        });

        console.log(chalk.green(`✔ Joined room ${chalk.bold(roomId)} successfully!`));
        console.log(chalk.dim(`  Config saved to ${result.configPath} (mode 0600)`));

        if (result.gitignoreCreated) {
          console.log(chalk.blue(`ℹ Created .gitignore and added ${CONFIG_FILE}`));
        } else if (result.gitignoreUpdated) {
          console.log(chalk.blue(`ℹ Added ${CONFIG_FILE} to .gitignore`));
        }

        console.log(chalk.dim('\nNext step: run "env-sync watch" to start syncing.'));
      } catch (error) {
        console.error(
          chalk.red(`✖ Failed to join room: ${error instanceof Error ? error.message : String(error)}`),
        );
        process.exit(1);
      }
    },
  );

program
  .command('watch')
  .description('Start watching and syncing using the local .shadow-sync.json configuration')
  .option('-f, --file <path>', 'Override target env file path')
  .option('-u, --url <wsUrl>', 'Override relay WebSocket URL')
  .action(async (opts: { file?: string; url?: string }) => {
    try {
      const config = loadConfig();
      if (!config) {
        console.error(
          chalk.red(
            `✖ No ${CONFIG_FILE} found. Run "env-sync init" or "env-sync join <roomId>" first.`,
          ),
        );
        process.exit(1);
      }

      const passphrase =
        resolvePassphrase(config) ||
        (await promptPassphrase(`Enter passphrase for room ${config.roomId}:`));

      const filePath = opts.file || config.file || '.env';
      const wsUrl = opts.url || config.serverUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;

      console.log(chalk.green('✔ Configuration verified. Deriving encryption key...'));
      const key = deriveKey(passphrase, config.roomId);

      const handle = await startSyncClient({
        roomId: config.roomId,
        key,
        filePath,
        wsUrl,
      });

      registerGracefulShutdown(() => handle.stop());
    } catch (error) {
      console.error(
        chalk.red(`✖ Failed to start watcher: ${error instanceof Error ? error.message : String(error)}`),
      );
      process.exit(1);
    }
  });

program
  .command('start <roomId>')
  .description('Directly start syncing a room without saving a local config file')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .action(async (roomId: string, opts: { file: string; url?: string }) => {
    if (!isValidRoomId(roomId)) {
      console.error(
        chalk.red('✖ Invalid Room ID. Use 3-64 alphanumeric, dash, or underscore characters.'),
      );
      process.exit(1);
    }

    try {
      const passphrase =
        process.env[PASSPHRASE_ENV_VAR] ||
        (await promptPassphrase('Enter the room passphrase:'));

      const wsUrl = opts.url || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;

      console.log(chalk.green('✔ Deriving encryption key...'));
      const key = deriveKey(passphrase, roomId);

      const handle = await startSyncClient({
        roomId,
        key,
        filePath: opts.file,
        wsUrl,
      });

      registerGracefulShutdown(() => handle.stop());
    } catch (error) {
      console.error(
        chalk.red(`✖ Failed to start sync: ${error instanceof Error ? error.message : String(error)}`),
      );
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Inspect the current shadow-sync configuration and security posture')
  .action(() => {
    try {
      const config = loadConfig();
      if (!config) {
        console.log(chalk.yellow(`No ${CONFIG_FILE} found in current directory.`));
        return;
      }

      const filePath = config.file || '.env';
      const envExists = fs.existsSync(filePath);
      const gitignoreOk = isGitignoreProtected();
      const wsUrl = config.serverUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
      const passphraseSource = process.env[PASSPHRASE_ENV_VAR]
        ? `env (${PASSPHRASE_ENV_VAR})`
        : config.passphrase
          ? `${CONFIG_FILE} (stored)`
          : 'prompt at runtime';

      console.log(chalk.bold('Shadow-Sync Status'));
      console.log(`  Room ID:       ${chalk.cyan(config.roomId)}`);
      console.log(`  Target File:   ${filePath} ${envExists ? chalk.green('(exists)') : chalk.yellow('(not created yet)')}`);
      console.log(`  Relay URL:     ${wsUrl}`);
      console.log(`  Passphrase:    ${passphraseSource}`);
      console.log(
        `  .gitignore:    ${gitignoreOk ? chalk.green(`protected (${CONFIG_FILE} ignored)`) : chalk.red(`WARNING: ${CONFIG_FILE} not in .gitignore!`)}`,
      );
    } catch (error) {
      console.error(
        chalk.red(`✖ Error reading status: ${error instanceof Error ? error.message : String(error)}`),
      );
      process.exit(1);
    }
  });

program
  .command('server')
  .description('Run a self-hosted zero-trust Shadow-Sync relay server')
  .option('-p, --port <port>', 'Port to listen on', process.env.PORT || '8080')
  .option('-H, --host <host>', 'Host interface to bind', '0.0.0.0')
  .action(async (opts: { port: string; host: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(chalk.red(`✖ Invalid port: ${opts.port}`));
      process.exit(1);
    }

    try {
      const relay = await createRelayServer({ port, host: opts.host });
      console.log(chalk.green(`✔ Shadow-Sync Relay Server listening on ${relay.url}`));
      console.log(chalk.dim(`  Health check: http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${relay.port}/health`));

      registerGracefulShutdown(() => relay.close());
    } catch (error) {
      console.error(
        chalk.red(`✖ Failed to start relay server: ${error instanceof Error ? error.message : String(error)}`),
      );
      process.exit(1);
    }
  });

program.parse(process.argv);
