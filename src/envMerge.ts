export interface KeyEntry {
  value: string | null; // null represents a deleted key (tombstone)
  updatedAt: number;
}

export type KeyStateMap = Record<string, KeyEntry>;

interface ParsedLine {
  type: 'entry' | 'other';
  raw: string;
  key?: string;
  prefix?: string; // e.g. "export " or leading spaces
  value?: string;
}

export interface EnvDiffEntry {
  key: string;
  kind: 'added' | 'removed' | 'modified';
  localValue?: string;
  remoteValue?: string;
}

export interface MergeResult {
  mergedContent: string;
  mergedKeys: KeyStateMap;
  changedLocal: boolean;
  localHasNewerKeys: boolean;
}

const ENV_LINE_REGEX = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseLines(content: string): ParsedLine[] {
  if (content === '') return [];
  const rawLines = content.split(/\r?\n/);
  // Drop trailing empty string caused by trailing newline so we manage trailing newline cleanly
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  return rawLines.map((raw) => {
    const match = ENV_LINE_REGEX.exec(raw);
    if (!match) {
      return { type: 'other', raw };
    }
    return {
      type: 'entry',
      raw,
      prefix: match[1] ?? '',
      key: match[2]!,
      value: match[3] ?? '',
    };
  });
}

/**
 * Parses a .env string into a map of key -> raw value (preserving quoting).
 */
export function parseEnvValues(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of parseLines(content)) {
    if (line.type === 'entry' && line.key !== undefined) {
      result[line.key] = line.value ?? '';
    }
  }
  return result;
}

/**
 * Strips any ignored keys from a .env string before encrypting/broadcasting.
 */
export function stripIgnoredKeys(content: string, ignoreKeys: readonly string[] = []): string {
  if (ignoreKeys.length === 0) return content;
  const ignoreSet = new Set(ignoreKeys);
  const lines = parseLines(content).filter(
    (line) => !(line.type === 'entry' && line.key && ignoreSet.has(line.key)),
  );
  if (lines.length === 0) return '';
  return `${lines.map((l) => l.raw).join('\n')}\n`;
}

/**
 * Builds or updates a per-key LWW metadata map by comparing the current .env
 * content against a previous KeyStateMap.
 */
export function updateKeyStateMap(
  previous: KeyStateMap,
  content: string,
  timestamp: number,
  ignoreKeys: readonly string[] = [],
): KeyStateMap {
  const ignoreSet = new Set(ignoreKeys);
  const currentValues = parseEnvValues(content);
  const next: KeyStateMap = {};

  // Update existing or newly added keys
  for (const [key, value] of Object.entries(currentValues)) {
    if (ignoreSet.has(key)) continue;
    const prev = previous[key];
    if (prev && prev.value === value) {
      next[key] = prev;
    } else {
      next[key] = { value, updatedAt: timestamp };
    }
  }

  // Record tombstones for keys that were previously present and are now removed
  for (const [key, prev] of Object.entries(previous)) {
    if (ignoreSet.has(key)) continue;
    if (!(key in currentValues)) {
      if (prev.value === null) {
        next[key] = prev;
      } else {
        next[key] = { value: null, updatedAt: timestamp };
      }
    }
  }

  return next;
}

/**
 * Applies a desired map of key -> value (or null to delete) onto a base .env text,
 * preserving comments, blank lines, export prefixes, and key ordering.
 */
export function renderEnvWithUpdates(
  baseContent: string,
  desiredValues: Record<string, string | null>,
  ignoreKeys: readonly string[] = [],
): string {
  const ignoreSet = new Set(ignoreKeys);
  const lines = parseLines(baseContent);
  const seenKeys = new Set<string>();
  const outputLines: string[] = [];

  for (const line of lines) {
    if (line.type !== 'entry' || !line.key) {
      outputLines.push(line.raw);
      continue;
    }

    const key = line.key;
    if (ignoreSet.has(key)) {
      outputLines.push(line.raw);
      seenKeys.add(key);
      continue;
    }

    if (!(key in desiredValues)) {
      outputLines.push(line.raw);
      seenKeys.add(key);
      continue;
    }

    const nextVal = desiredValues[key];
    seenKeys.add(key);
    if (nextVal === null) {
      // Key deleted via tombstone
      continue;
    }
    outputLines.push(`${line.prefix ?? ''}${key}=${nextVal}`);
  }

  // Append newly added keys that were not in baseContent
  for (const [key, val] of Object.entries(desiredValues)) {
    if (ignoreSet.has(key) || seenKeys.has(key) || val === null) {
      continue;
    }
    outputLines.push(`${key}=${val}`);
  }

  if (outputLines.length === 0) return '';
  return `${outputLines.join('\n')}\n`;
}

/**
 * Performs a per-key Last-Write-Wins (LWW) CRDT merge between local and remote
 * .env states while preserving local comments, formatting, and ignoreKeys.
 */
export function mergeEnvStates(params: {
  localContent: string;
  localKeys: KeyStateMap;
  remoteContent: string;
  remoteKeys: KeyStateMap;
  ignoreKeys?: readonly string[];
}): MergeResult {
  const { localContent, localKeys, remoteContent, remoteKeys, ignoreKeys = [] } = params;
  const ignoreSet = new Set(ignoreKeys);

  const localValues = parseEnvValues(localContent);
  const remoteValues = parseEnvValues(remoteContent);

  const allKeys = new Set<string>([
    ...Object.keys(localValues),
    ...Object.keys(localKeys),
    ...Object.keys(remoteValues),
    ...Object.keys(remoteKeys),
  ]);

  const mergedKeys: KeyStateMap = {};
  const desiredValues: Record<string, string | null> = {};
  let changedLocal = false;
  let localHasNewerKeys = false;

  for (const key of allKeys) {
    if (ignoreSet.has(key)) continue;

    const localEntry: KeyEntry | undefined =
      localKeys[key] ??
      (key in localValues ? { value: localValues[key]!, updatedAt: 0 } : undefined);
    const remoteEntry: KeyEntry | undefined =
      remoteKeys[key] ??
      (key in remoteValues ? { value: remoteValues[key]!, updatedAt: 0 } : undefined);

    if (localEntry && !remoteEntry) {
      mergedKeys[key] = localEntry;
      desiredValues[key] = localEntry.value;
      if (localEntry.value !== null) {
        localHasNewerKeys = true;
      }
      continue;
    }

    if (!localEntry && remoteEntry) {
      mergedKeys[key] = remoteEntry;
      desiredValues[key] = remoteEntry.value;
      if (remoteEntry.value !== null) {
        changedLocal = true;
      }
      continue;
    }

    if (localEntry && remoteEntry) {
      if (localEntry.value === remoteEntry.value) {
        mergedKeys[key] = {
          value: localEntry.value,
          updatedAt: Math.max(localEntry.updatedAt, remoteEntry.updatedAt),
        };
        desiredValues[key] = localEntry.value;
      } else if (remoteEntry.updatedAt > localEntry.updatedAt) {
        mergedKeys[key] = remoteEntry;
        desiredValues[key] = remoteEntry.value;
        changedLocal = true;
      } else if (localEntry.updatedAt > remoteEntry.updatedAt) {
        mergedKeys[key] = localEntry;
        desiredValues[key] = localEntry.value;
        localHasNewerKeys = true;
      } else {
        // Equal timestamp tie-breaker: deterministic lexicographical order so all peers converge
        const localStr = localEntry.value ?? '';
        const remoteStr = remoteEntry.value ?? '';
        if (remoteStr > localStr) {
          mergedKeys[key] = remoteEntry;
          desiredValues[key] = remoteEntry.value;
          changedLocal = true;
        } else {
          mergedKeys[key] = localEntry;
          desiredValues[key] = localEntry.value;
          localHasNewerKeys = true;
        }
      }
    }
  }

  // If local was completely empty (cold start) and remote has full content with comments,
  // adopt remoteContent's formatting/comments directly (respecting ignoreKeys).
  let mergedContent: string;
  if (localContent.trim() === '' && changedLocal && !localHasNewerKeys) {
    mergedContent = renderEnvWithUpdates(remoteContent, desiredValues, ignoreKeys);
  } else if (changedLocal) {
    mergedContent = renderEnvWithUpdates(localContent, desiredValues, ignoreKeys);
  } else {
    mergedContent = localContent;
  }

  return {
    mergedContent,
    mergedKeys,
    changedLocal,
    localHasNewerKeys,
  };
}

/**
 * Masks a secret value for safe display in CLI diffs.
 */
export function maskSecretValue(value: string): string {
  const unquoted = value.replace(/^["']|["']$/g, '');
  if (unquoted.length <= 4) {
    return '****';
  }
  if (unquoted.length <= 8) {
    return `${unquoted.slice(0, 1)}***${unquoted.slice(-1)}`;
  }
  return `${unquoted.slice(0, 3)}***${unquoted.slice(-2)}`;
}

/**
 * Computes a key-level diff between local and remote .env contents,
 * excluding ignored keys.
 */
export function computeEnvDiff(
  localContent: string,
  remoteContent: string,
  ignoreKeys: readonly string[] = [],
): EnvDiffEntry[] {
  const ignoreSet = new Set(ignoreKeys);
  const localValues = parseEnvValues(localContent);
  const remoteValues = parseEnvValues(remoteContent);

  const allKeys = Array.from(
    new Set([...Object.keys(localValues), ...Object.keys(remoteValues)]),
  ).sort();

  const diffs: EnvDiffEntry[] = [];

  for (const key of allKeys) {
    if (ignoreSet.has(key)) continue;
    const inLocal = key in localValues;
    const inRemote = key in remoteValues;

    if (!inLocal && inRemote) {
      diffs.push({ key, kind: 'added', remoteValue: remoteValues[key] });
    } else if (inLocal && !inRemote) {
      diffs.push({ key, kind: 'removed', localValue: localValues[key] });
    } else if (localValues[key] !== remoteValues[key]) {
      diffs.push({
        key,
        kind: 'modified',
        localValue: localValues[key],
        remoteValue: remoteValues[key],
      });
    }
  }

  return diffs;
}
