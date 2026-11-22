# Shadow-Sync (`env-sync`)

**Real-time, zero-trust, end-to-end encrypted `.env` synchronizer for development teams.**

Stop pasting secrets over Slack or managing brittle shared `.env` files. Shadow-Sync keeps your team's local `.env` files synchronized in real time over a zero-trust WebSocket relay using **AES-256-GCM** encryption, **PBKDF2-SHA256** key derivation, and **Last-Write-Wins (LWW)** conflict resolution.

## Prerequisites

- **Node.js v18 or higher**

## Installation

Install globally via npm to use the `env-sync` CLI anywhere:

```bash
npm install -g shadow-sync
```

Or from a local clone:

```bash
npm install
npm run build
npm link
```

## Usage

Run commands from the root directory of your project. By default, `env-sync` targets `.env` in the current working directory (override with `-f, --file <path>`).

> **Cold Start:** If you run `watch` or `start` in a directory without a `.env` file, Shadow-Sync creates one automatically and populates it from your online teammates.

### 1. Initialize a New Room

Creates a cryptographically secure Room ID (e.g. `A7K9-M2P4-X8Q3`), saves `.shadow-sync.json` with `0600` (owner-only) permissions, and automatically ensures `.shadow-sync.json` is listed in `.gitignore`.

```bash
env-sync init
```

Options:
- `-f, --file <path>` — Target env file path (default: `.env`)
- `-u, --url <wsUrl>` — Custom relay WebSocket URL
- `--no-save-passphrase` — Do not write the passphrase to `.shadow-sync.json` (prompt at runtime or read from `SHADOW_SYNC_PASSPHRASE`)

### 2. Join an Existing Room

```bash
env-sync join <roomId>
```

Supports the same `-f`, `-u`, and `--no-save-passphrase` options as `init`.

### 3. Watch and Sync

Starts the file watcher and connects to the relay server using `.shadow-sync.json`:

```bash
env-sync watch
```

Press `Ctrl + C` for a clean shutdown.

### 4. Direct Start (No Config File)

Connect to a room directly without writing `.shadow-sync.json`:

```bash
env-sync start <roomId>
```

### 5. Inspect Status

Check your active room configuration, target file, relay URL, and `.gitignore` protection:

```bash
env-sync status
```

### 6. Self-Host the Relay Server

Run your own zero-trust relay server directly from the CLI:

```bash
env-sync server --port 8080
```

A health check endpoint is exposed at `GET /health` returning `{ "status": "ok", "rooms": ..., "clients": ... }`.

You can also deploy the standalone [`server/`](./server) directory directly to Render, Railway, or Fly.io (`npm install && npm start`).

## Environment Variables

| Variable | Description |
| --- | --- |
| `SHADOW_SYNC_PASSPHRASE` | Supplies the room passphrase without storing it on disk or prompting interactively |
| `SYNC_WS_URL` | Overrides the default relay WebSocket URL (`wss://shadow-sync.onrender.com`) |
| `PORT` | Port used by the relay server (default: `8080`) |

## Security & Architecture

- **Zero-Trust Relay:** The WebSocket relay routes opaque ciphertext between room peers. It enforces payload size limits (1 MiB), validates room IDs, and evicts stale connections via ping/pong heartbeats, but never sees your passphrase or plaintext secrets.
- **Authenticated Encryption (AES-256-GCM):** Every sync update wraps both the `.env` content and its LWW timestamp inside a JSON envelope encrypted with a random 96-bit IV and bound to the `roomId` via Additional Authenticated Data (AAD), preventing tampering and cross-room replay.
- **Key Derivation:** 256-bit keys are derived locally with PBKDF2-HMAC-SHA256 (600,000 iterations) using a domain-separated room salt.
- **Resilient State Reconciliation:** Uses atomic file writes, echo suppression, cold-start protection, empty-overwrite refusal, exponential backoff with jitter on reconnect, and automatic push of offline edits upon reconnection.
- **Local Credential Hygiene:** `.shadow-sync.json` is written with `0600` permissions, auto-added to `.gitignore`, and can be kept passphrase-free via `--no-save-passphrase` + `SHADOW_SYNC_PASSPHRASE`.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```
