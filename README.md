# 🕵️‍♂️ Env-Sync (Shadow-Sync)

**Real-time, zero-trust E2E encrypted environment variable synchronizer.**

Tired of securely sharing `.env` files with your team by copy-pasting over Slack or sharing brittle passwords? Env-Sync is a CLI tool that allows developers to seamlessly synchronize their `.env` files in real-time across a shared development room. It utilizes **zero-trust End-to-End (E2E) encryption** and robust **Last-Write-Wins (LWW) conflict resolution** to ensure your local environments are perfectly synced, securely, and without race conditions.

## 📋 Prerequisites

Ensure you have **Node.js (v16 or higher)** installed on your system before proceeding.

## 📦 Installation

Install the package globally using npm to access the `env-sync` command from anywhere:

```bash
npm install -g shadow-sync
```

*(Alternatively, if you've cloned the repository, you can run `npm link` in the project root to install it locally).*

## 🚀 Usage

Env-Sync provides a simple, intuitive CLI to manage your synchronization rooms.

**Important:** All commands must be run from the **root folder of your project**, as Env-Sync strictly targets the `.env` file in your Current Working Directory (CWD).

> **Missing File?** If you run `join` or `start` in a directory that doesn't have a `.env` file yet, Env-Sync will automatically create a new `.env` file for you and gracefully populate it with the remote state from your team!

### 1. Initialize a New Room
Create a brand new room to start syncing your `.env` file. You will be prompted to create a secure passphrase.

```bash
env-sync init
```
*Output: Provides you with a unique Room ID to share with your team.*

### 2. Join an Existing Room
Join a teammate's room using their Room ID. You will be prompted to enter the room's secure passphrase.

```bash
env-sync join <roomId>
```
*Example: `env-sync join X7B9A2`*

### 3. Start the Sync Server (Direct)
Directly start the synchronization server for a specific room. This will connect to the room and immediately sync your local `.env` state.

```bash
env-sync start <roomId>
```
*Example: `env-sync start X7B9A2`*

### 4. Watch for Changes (Background)
Once you have initialized or joined a room, run the watcher. It will continuously monitor your `.env` file and instantly push any local changes to your team, as well as apply incoming changes from them.

```bash
env-sync watch
```

*To safely stop the watcher and disconnect from the server, simply press `Ctrl + C` in your terminal.*

## 🏗️ Architecture

Env-Sync is built with privacy and security as its absolute core principles:

- **Zero-Trust Server:** The synchronization runs over a fast WebSocket server. However, the server acts *only* as a dumb relay. It routes messages between peers but cannot read them.
- **Client-Side E2E Encryption:** All `.env` contents are encrypted locally on your machine using **AES-256-GCM** encryption before ever hitting the network. 
- **Secure Key Derivation:** The encryption key is derived securely from your Room ID and the Passphrase (which is never transmitted). Without the passphrase, the payload is cryptographically impossible to read.
- **Robust State Management:** Implements Last-Write-Wins (LWW) timestamps and empty-overwrite protections to gracefully handle offline modifications, sudden disconnects, and simultaneous teammate edits.
