import fs from 'fs/promises';

export class StateManager {
  constructor(filePath = '.env') {
    this.filePath = filePath;
    this.lastKnownContent = '';
  }

  async ensureFileExists() {
    try {
      await fs.access(this.filePath);
      return false; // file exists
    } catch {
      await fs.writeFile(this.filePath, '', 'utf8');
      return true; // file was created
    }
  }

  async getLocalState() {
    let created = await this.ensureFileExists();
    const stats = await fs.stat(this.filePath);
    const content = await fs.readFile(this.filePath, 'utf8');
    
    // If we just created it, use Date.now() to ensure the timestamp is extremely fresh,
    // otherwise use the actual mtimeMs from the filesystem.
    return { 
      content, 
      timestamp: created ? Date.now() : Math.floor(stats.mtimeMs), 
      created 
    };
  }

  async evaluateUpdate(decryptedContent, incomingTimestampRaw) {
    const incomingTimestamp = parseInt(incomingTimestampRaw, 10);
    
    let localContent = '';
    let localMtimeMs = 0;
    try {
      const stats = await fs.stat(this.filePath);
      localMtimeMs = stats.mtimeMs;
      localContent = await fs.readFile(this.filePath, 'utf8');
    } catch (e) {
      // File might not exist
    }

    // Empty Overwrites Check
    if (decryptedContent.trim() === '' && localContent.trim() !== '') {
      return { action: 'pushback', localContent, localTimestamp: localMtimeMs, reason: 'empty_overwrite' };
    }

    // The Footrace Check
    if (incomingTimestamp && Math.floor(localMtimeMs) > incomingTimestamp) {
      return { action: 'pushback', localContent, localTimestamp: Math.floor(localMtimeMs), reason: 'footrace' };
    }

    // THE FIX: Ignore ghost echoes
    if (decryptedContent === this.lastKnownContent) {
      return { action: 'ignored' };
    }

    // Update our tracker BEFORE writing to the file
    this.lastKnownContent = decryptedContent;

    await fs.writeFile(this.filePath, decryptedContent, 'utf8');
    return { action: 'updated' };
  }

  checkAndTrackLocalUpdate(fileContent) {
    if (fileContent === this.lastKnownContent) return false;
    this.lastKnownContent = fileContent;
    return true;
  }
}
