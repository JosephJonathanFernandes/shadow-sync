# Shadow-Sync (`env-sync`)

**Real-time, zero-trust, end-to-end encrypted `.env` synchronizer for development teams.**

Stop pasting secrets over Slack or managing brittle shared `.env` files. Shadow-Sync keeps your team's local `.env` files synchronized using **AES-256-GCM** encryption, **PBKDF2-SHA256** key derivation, **per-key Last-Write-Wins (LWW) CRDT merging**, and a **zero-trust encrypted relay cache** so even async/offline teammates stay in sync.

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

> **Cold Start:** If you run `pull`, `watch`, or `start` in a directory without a `.env` file, Shadow-Sync creates one automatically and populates it from your team's cached or live state.

### 1. Initialize a New Room

Creates a cryptographically secure Room ID (e.g. `A7K9-M2P4-X8Q3`), saves `.shadow-sync.json` with `0600` (owner-only) permissions, and guarantees `.shadow-sync.json` is listed in `.gitignore`.

```bash
env-sync init
```

Common options (supported on `init`, `join`, `watch`, `push`, `pull`, `diff`):
- `-P, --profile <name>` — Manage multiple environments (e.g. `staging`, `prod`) in `.shadow-sync.json`
- `-f, --file <path>` — Target env file path (default: `.env`)
- `-u, --url <wsUrl>` — Custom relay WebSocket URL
- `-i, --ignore <keys>` — Comma-separated local-only keys (e.g. `PORT,LOCAL_DB`) never synced or overwritten
- `--no-save-passphrase` — Do not write the passphrase to `.shadow-sync.json` (prompt at runtime or read from `SHADOW_SYNC_PASSPHRASE`)

### 2. Join an Existing Room

```bash
env-sync join <roomId>
```

### 3. One-Shot Sync (`push`, `pull`, `diff`)

Sync on demand without running a background watcher:

```bash
env-sync push            # Encrypt and push local .env to the room (and relay cache)
env-sync diff            # Preview incoming changes with secret values masked (add --reveal to unmask)
env-sync pull            # Fetch and CRDT-merge remote updates into local .env
```

### 4. Real-Time Watch

Continuously watch and merge changes in real time:

```bash
env-sync watch
```

Press `Ctrl + C` for a clean shutdown.

### 5. Direct Start (No Config File)

Connect to a room directly without writing `.shadow-sync.json`:

```bash
env-sync start <roomId>
```

### 6. Rotate Room Credentials

Generate a fresh Room ID and passphrase, update `.shadow-sync.json`, and push the freshly re-encrypted `.env`:

```bash
env-sync rotate
```

*(Pass `--keep-room-id` to rotate only the passphrase while keeping the same Room ID.)*

### 7. Inspect Status

Check your active room configuration, profiles, ignored keys, relay URL, and `.gitignore` protection:

```bash
env-sync status
env-sync status --profile staging
```

### 8. Self-Host the Relay Server

Run your own zero-trust relay server directly from the CLI:

```bash
env-sync server --port 8080 --ttl 24
```

- Exposes `GET /health` returning `{ "status": "ok", "rooms": ..., "clients": ..., "cachedRooms": ... }`.
- Retains only opaque encrypted ciphertext in an in-memory TTL + LRU cache (configurable via `--ttl <hours>`, set `0` to disable).
- You can also deploy the standalone [`server/`](./server) directory directly to Render, Railway, or Fly.io (`npm install && npm start`).

## Environment Variables

| Variable | Description |
| --- | --- |
| `SHADOW_SYNC_PASSPHRASE` | Supplies the room passphrase without storing it on disk or prompting interactively |
| `SYNC_WS_URL` | Overrides the default relay WebSocket URL (`wss://shadow-sync.onrender.com`) |
| `PORT` | Port used by the relay server (default: `8080`) |
| `SNAPSHOT_TTL_MS` | Encrypted snapshot cache TTL in ms for standalone `server/server.js` (default: 24h) |
| `MAX_CACHED_ROOMS` | Max rooms in the LRU cache for standalone `server/server.js` (default: `500`) |

## Security & Architecture

- **Zero-Trust Relay & Encrypted Cache:** The WebSocket relay routes and optionally caches only opaque AES-256-GCM ciphertext. It enforces payload limits (1 MiB), validates room IDs, and evicts stale connections via ping/pong heartbeats, but never sees your passphrase or plaintext secrets.
- **Authenticated Envelopes (v2):** Every sync update wraps `.env` content, LWW timestamp, and per-key timestamps/tombstones inside AES-256-GCM ciphertext bound to `roomId` via Additional Authenticated Data (AAD), preventing tampering and cross-room replay.
- **Per-Key LWW CRDT Merge:** Concurrent edits to different keys merge cleanly while preserving local comments, formatting, and `ignoreKeys`.
- **Key Derivation:** 256-bit keys are derived locally with PBKDF2-HMAC-SHA256 (600,000 iterations) using a domain-separated room salt.
- **Local Credential Hygiene:** `.shadow-sync.json` is written with `0600` permissions, auto-added to `.gitignore`, and can be kept passphrase-free via `--no-save-passphrase` + `SHADOW_SYNC_PASSPHRASE`.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```
