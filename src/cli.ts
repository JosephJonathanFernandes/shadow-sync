#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { program } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import {
  CONFIG_FILE,
  PASSPHRASE_ENV_VAR,
  SERVER_URL_ENV_VAR,
  isGitignoreProtected,
  listProfiles,
  loadConfig,
  resolvePassphrase,
  saveConfig,
} from './config.js';
import { DecryptionError, deriveKey, generateRoomId } from './crypto.js';
import { type EnvDiffEntry, maskSecretValue } from './envMerge.js';
import { pullOnce, pushOnce, rotateRoom } from './operations.js';
import { DEFAULT_RELAY_URL, isValidRoomId } from './protocol.js';
import { createRelayServer } from './server.js';
import { startSyncClient } from './sync.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

function parseIgnoreKeys(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

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

function printDiffs(diffs: EnvDiffEntry[], reveal = false): void {
  if (diffs.length === 0) {
    console.log(chalk.green('✔ Local file is already up to date with remote state.'));
    return;
  }

  const fmt = (val?: string) => (val === undefined ? '' : reveal ? val : maskSecretValue(val));

  for (const d of diffs) {
    if (d.kind === 'added') {
      console.log(chalk.green(`  + ${d.key}=${fmt(d.remoteValue)}`));
    } else if (d.kind === 'removed') {
      console.log(chalk.red(`  - ${d.key}=${fmt(d.localValue)}`));
    } else {
      console.log(
        chalk.yellow(`  ~ ${d.key}: ${fmt(d.localValue)} -> ${fmt(d.remoteValue)}`),
      );
    }
  }
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

async function resolveSession(opts: {
  profile?: string;
  file?: string;
  url?: string;
  ignore?: string;
}) {
  const config = loadConfig(process.cwd(), opts.profile);
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
  const wsUrl =
    opts.url || config.serverUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
  const ignoreKeys = parseIgnoreKeys(opts.ignore) ?? config.ignoreKeys ?? [];

  return { config, passphrase, filePath, wsUrl, ignoreKeys };
}

program
  .name('env-sync')
  .description('Real-time, zero-trust E2E encrypted environment variable synchronizer')
  .version(pkg.version);

program
  .command('init')
  .description('Initialize a new shadow-sync room in the current directory')
  .option('-P, --profile <name>', 'Save under a named environment profile (e.g. staging, prod)')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Comma-separated local-only keys never synced or overwritten')
  .option(
    '--no-save-passphrase',
    `Do not store passphrase in ${CONFIG_FILE} (prompt or use ${PASSPHRASE_ENV_VAR})`,
  )
  .action(
    async (opts: {
      profile?: string;
      file: string;
      url?: string;
      ignore?: string;
      savePassphrase: boolean;
    }) => {
      try {
        const passphrase =
          process.env[PASSPHRASE_ENV_VAR] ||
          (await promptPassphrase('Enter a passphrase for the room:', true));

        const roomId = generateRoomId();
        const ignoreKeys = parseIgnoreKeys(opts.ignore);
        const result = saveConfig(roomId, passphrase, {
          savePassphrase: opts.savePassphrase,
          file: opts.file,
          serverUrl: opts.url,
          ignoreKeys,
          profile: opts.profile,
        });

        console.log(
          chalk.green(
            `✔ Room created successfully${opts.profile ? ` (profile: ${opts.profile})` : ''}!`,
          ),
        );
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
              `ℹ Passphrase was not written to disk. Set ${PASSPHRASE_ENV_VAR} or enter it at runtime.`,
            ),
          );
        }

        const profileFlag = opts.profile ? ` --profile ${opts.profile}` : '';
        console.log(
          chalk.dim(
            `\nNext steps: "env-sync push${profileFlag}" or "env-sync watch${profileFlag}"`,
          ),
        );
      } catch (error) {
        console.error(
          chalk.red(
            `✖ Failed to initialize room: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('join <roomId>')
  .description('Join an existing shadow-sync room')
  .option('-P, --profile <name>', 'Save under a named environment profile (e.g. staging, prod)')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Comma-separated local-only keys never synced or overwritten')
  .option(
    '--no-save-passphrase',
    `Do not store passphrase in ${CONFIG_FILE} (prompt or use ${PASSPHRASE_ENV_VAR})`,
  )
  .action(
    async (
      roomId: string,
      opts: {
        profile?: string;
        file: string;
        url?: string;
        ignore?: string;
        savePassphrase: boolean;
      },
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

        const ignoreKeys = parseIgnoreKeys(opts.ignore);
        const result = saveConfig(roomId, passphrase, {
          savePassphrase: opts.savePassphrase,
          file: opts.file,
          serverUrl: opts.url,
          ignoreKeys,
          profile: opts.profile,
        });

        console.log(
          chalk.green(
            `✔ Joined room ${chalk.bold(roomId)}${opts.profile ? ` (profile: ${opts.profile})` : ''}!`,
          ),
        );
        console.log(chalk.dim(`  Config saved to ${result.configPath} (mode 0600)`));

        if (result.gitignoreCreated) {
          console.log(chalk.blue(`ℹ Created .gitignore and added ${CONFIG_FILE}`));
        } else if (result.gitignoreUpdated) {
          console.log(chalk.blue(`ℹ Added ${CONFIG_FILE} to .gitignore`));
        }

        const profileFlag = opts.profile ? ` --profile ${opts.profile}` : '';
        console.log(
          chalk.dim(
            `\nNext steps: "env-sync pull${profileFlag}" or "env-sync watch${profileFlag}"`,
          ),
        );
      } catch (error) {
        console.error(
          chalk.red(
            `✖ Failed to join room: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('watch')
  .description('Start watching and syncing in real time using .shadow-sync.json')
  .option('-P, --profile <name>', 'Named environment profile to use')
  .option('-f, --file <path>', 'Override target env file path')
  .option('-u, --url <wsUrl>', 'Override relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Override comma-separated local-only keys')
  .action(
    async (opts: { profile?: string; file?: string; url?: string; ignore?: string }) => {
      try {
        const { config, passphrase, filePath, wsUrl, ignoreKeys } =
          await resolveSession(opts);

        console.log(chalk.green('✔ Configuration verified. Deriving encryption key...'));
        const key = deriveKey(passphrase, config.roomId);

        const handle = await startSyncClient({
          roomId: config.roomId,
          key,
          filePath,
          wsUrl,
          ignoreKeys,
        });

        registerGracefulShutdown(() => handle.stop());
      } catch (error) {
        console.error(
          chalk.red(
            `✖ Failed to start watcher: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('push')
  .description('One-shot push: encrypt and push local .env to the room and exit')
  .option('-P, --profile <name>', 'Named environment profile to use')
  .option('-f, --file <path>', 'Override target env file path')
  .option('-u, --url <wsUrl>', 'Override relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Override comma-separated local-only keys')
  .action(
    async (opts: { profile?: string; file?: string; url?: string; ignore?: string }) => {
      const spinner = ora('Encrypting and pushing local .env...').start();
      try {
        spinner.stop();
        const { config, passphrase, filePath, wsUrl, ignoreKeys } =
          await resolveSession(opts);
        spinner.start(`Encrypting and pushing ${filePath} to room ${config.roomId}...`);

        const key = deriveKey(passphrase, config.roomId);
        const res = await pushOnce({
          roomId: config.roomId,
          key,
          filePath,
          wsUrl,
          ignoreKeys,
        });

        spinner.succeed(
          chalk.green(
            `Pushed ${res.keyCount} encrypted key${res.keyCount === 1 ? '' : 's'} to room ${res.roomId}.`,
          ),
        );
      } catch (error) {
        spinner.fail(
          chalk.red(
            `Failed to push: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('pull')
  .description('One-shot pull: fetch latest encrypted state from relay/peers and merge locally')
  .option('-P, --profile <name>', 'Named environment profile to use')
  .option('-f, --file <path>', 'Override target env file path')
  .option('-u, --url <wsUrl>', 'Override relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Override comma-separated local-only keys')
  .option('-t, --timeout <ms>', 'Timeout waiting for remote state in ms', '3000')
  .action(
    async (opts: {
      profile?: string;
      file?: string;
      url?: string;
      ignore?: string;
      timeout: string;
    }) => {
      const spinner = ora();
      try {
        const { config, passphrase, filePath, wsUrl, ignoreKeys } =
          await resolveSession(opts);
        const timeoutMs = Number.parseInt(opts.timeout, 10) || 3000;

        spinner.start(`Pulling latest state for room ${config.roomId}...`);
        const key = deriveKey(passphrase, config.roomId);
        const res = await pullOnce({
          roomId: config.roomId,
          key,
          filePath,
          wsUrl,
          ignoreKeys,
          timeoutMs,
        });

        if (!res.received) {
          spinner.warn(
            chalk.yellow(
              'No cached snapshot or online peer responded within the timeout.',
            ),
          );
          return;
        }

        if (res.applied) {
          spinner.succeed(chalk.green(`Merged remote updates into ${filePath}:`));
          printDiffs(res.diffs, false);
        } else {
          spinner.succeed(chalk.green(`${filePath} is already up to date.`));
        }
      } catch (error) {
        if (error instanceof DecryptionError) {
          spinner.fail(
            chalk.red('Decryption failed: check that your passphrase matches the room.'),
          );
        } else {
          spinner.fail(
            chalk.red(
              `Failed to pull: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        process.exit(1);
      }
    },
  );

program
  .command('diff')
  .description('Preview incoming remote changes against local .env (values masked by default)')
  .option('-P, --profile <name>', 'Named environment profile to use')
  .option('-f, --file <path>', 'Override target env file path')
  .option('-u, --url <wsUrl>', 'Override relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Override comma-separated local-only keys')
  .option('--reveal', 'Show plaintext secret values in diff output', false)
  .option('-t, --timeout <ms>', 'Timeout waiting for remote state in ms', '3000')
  .action(
    async (opts: {
      profile?: string;
      file?: string;
      url?: string;
      ignore?: string;
      reveal: boolean;
      timeout: string;
    }) => {
      const spinner = ora();
      try {
        const { config, passphrase, filePath, wsUrl, ignoreKeys } =
          await resolveSession(opts);
        const timeoutMs = Number.parseInt(opts.timeout, 10) || 3000;

        spinner.start(`Fetching remote state for room ${config.roomId}...`);
        const key = deriveKey(passphrase, config.roomId);
        const res = await pullOnce({
          roomId: config.roomId,
          key,
          filePath,
          wsUrl,
          ignoreKeys,
          timeoutMs,
          dryRun: true,
        });

        if (!res.received) {
          spinner.warn(
            chalk.yellow(
              'No cached snapshot or online peer responded within the timeout.',
            ),
          );
          return;
        }

        spinner.stop();
        console.log(chalk.bold(`Diff for ${filePath} (room ${config.roomId}):`));
        printDiffs(res.diffs, opts.reveal);
      } catch (error) {
        if (error instanceof DecryptionError) {
          spinner.fail(
            chalk.red('Decryption failed: check that your passphrase matches the room.'),
          );
        } else {
          spinner.fail(
            chalk.red(
              `Failed to compute diff: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        process.exit(1);
      }
    },
  );

program
  .command('rotate')
  .description('Rotate room credentials (new Room ID & passphrase) and re-encrypt local .env')
  .option('-P, --profile <name>', 'Named environment profile to rotate')
  .option('--keep-room-id', 'Keep the existing Room ID and only rotate the passphrase', false)
  .option(
    '--no-save-passphrase',
    `Do not store the new passphrase in ${CONFIG_FILE}`,
  )
  .action(
    async (opts: {
      profile?: string;
      keepRoomId: boolean;
      savePassphrase: boolean;
    }) => {
      try {
        const config = loadConfig(process.cwd(), opts.profile);
        if (!config) {
          console.error(
            chalk.red(`✖ No ${CONFIG_FILE} found. Run "env-sync init" first.`),
          );
          process.exit(1);
        }

        const newPassphrase = await promptPassphrase(
          'Enter the NEW passphrase for the room:',
          true,
        );

        const spinner = ora('Rotating room key and pushing re-encrypted state...').start();
        const res = await rotateRoom({
          newPassphrase,
          newRoomId: opts.keepRoomId ? config.roomId : undefined,
          filePath: config.file || '.env',
          wsUrl: config.serverUrl,
          ignoreKeys: config.ignoreKeys,
          savePassphrase: opts.savePassphrase,
          profile: opts.profile,
        });

        spinner.succeed(chalk.green('Room credentials rotated and re-encrypted state pushed!'));
        console.log(chalk.blue(`ℹ New Room ID: ${chalk.bold(res.newRoomId)}`));
        console.log(
          chalk.dim(
            `  Share the new Room ID and passphrase with teammates so they can run "env-sync join ${res.newRoomId}".`,
          ),
        );
      } catch (error) {
        console.error(
          chalk.red(
            `✖ Failed to rotate room: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('start <roomId>')
  .description('Directly start syncing a room without saving a local config file')
  .option('-f, --file <path>', 'Target env file path', '.env')
  .option('-u, --url <wsUrl>', 'Custom relay WebSocket URL')
  .option('-i, --ignore <keys>', 'Comma-separated local-only keys')
  .action(
    async (
      roomId: string,
      opts: { file: string; url?: string; ignore?: string },
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
          (await promptPassphrase('Enter the room passphrase:'));

        const wsUrl = opts.url || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
        const ignoreKeys = parseIgnoreKeys(opts.ignore) ?? [];

        console.log(chalk.green('✔ Deriving encryption key...'));
        const key = deriveKey(passphrase, roomId);

        const handle = await startSyncClient({
          roomId,
          key,
          filePath: opts.file,
          wsUrl,
          ignoreKeys,
        });

        registerGracefulShutdown(() => handle.stop());
      } catch (error) {
        console.error(
          chalk.red(
            `✖ Failed to start sync: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    },
  );

program
  .command('status')
  .description('Inspect the current shadow-sync configuration and security posture')
  .option('-P, --profile <name>', 'Inspect a specific named profile')
  .action((opts: { profile?: string }) => {
    try {
      const config = loadConfig(process.cwd(), opts.profile);
      if (!config) {
        console.log(chalk.yellow(`No ${CONFIG_FILE} found in current directory.`));
        return;
      }

      const filePath = config.file || '.env';
      const envExists = fs.existsSync(filePath);
      const gitignoreOk = isGitignoreProtected();
      const wsUrl = config.serverUrl || process.env[SERVER_URL_ENV_VAR] || DEFAULT_RELAY_URL;
      const profiles = listProfiles();
      const passphraseSource = process.env[PASSPHRASE_ENV_VAR]
        ? `env (${PASSPHRASE_ENV_VAR})`
        : config.passphrase
          ? `${CONFIG_FILE} (stored, 0600)`
          : 'prompt at runtime';

      console.log(
        chalk.bold(`Shadow-Sync Status${opts.profile ? ` [${opts.profile}]` : ''}`),
      );
      console.log(`  Room ID:       ${chalk.cyan(config.roomId)}`);
      console.log(
        `  Target File:   ${filePath} ${envExists ? chalk.green('(exists)') : chalk.yellow('(not created yet)')}`,
      );
      console.log(`  Relay URL:     ${wsUrl}`);
      console.log(`  Passphrase:    ${passphraseSource}`);
      if (config.ignoreKeys && config.ignoreKeys.length > 0) {
        console.log(`  Ignored Keys:  ${config.ignoreKeys.join(', ')}`);
      }
      if (profiles.length > 0) {
        console.log(`  Profiles:      ${profiles.join(', ')}`);
      }
      console.log(
        `  .gitignore:    ${gitignoreOk ? chalk.green(`protected (${CONFIG_FILE} ignored)`) : chalk.red(`WARNING: ${CONFIG_FILE} not in .gitignore!`)}`,
      );
    } catch (error) {
      console.error(
        chalk.red(
          `✖ Error reading status: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

program
  .command('server')
  .description('Run a self-hosted zero-trust Shadow-Sync relay server')
  .option('-p, --port <port>', 'Port to listen on', process.env.PORT || '8080')
  .option('-H, --host <host>', 'Host interface to bind', '0.0.0.0')
  .option('--ttl <hours>', 'Encrypted room snapshot cache TTL in hours (0 disables)', '24')
  .action(async (opts: { port: string; host: string; ttl: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error(chalk.red(`✖ Invalid port: ${opts.port}`));
      process.exit(1);
    }

    const ttlHours = Number.parseFloat(opts.ttl);
    const snapshotTtlMs =
      Number.isFinite(ttlHours) && ttlHours >= 0
        ? Math.round(ttlHours * 60 * 60 * 1000)
        : 24 * 60 * 60 * 1000;

    try {
      const relay = await createRelayServer({
        port,
        host: opts.host,
        snapshotTtlMs,
      });
      console.log(chalk.green(`✔ Shadow-Sync Relay Server listening on ${relay.url}`));
      console.log(
        chalk.dim(
          `  Health check: http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${relay.port}/health`,
        ),
      );
      console.log(
        chalk.dim(
          `  Zero-trust cache: ${snapshotTtlMs > 0 ? `${ttlHours}h TTL` : 'disabled'}`,
        ),
      );

      registerGracefulShutdown(() => relay.close());
    } catch (error) {
      console.error(
        chalk.red(
          `✖ Failed to start relay server: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  });

program.parse(process.argv);
