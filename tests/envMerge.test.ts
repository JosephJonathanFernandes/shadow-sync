import { describe, expect, it } from 'vitest';
import {
  computeEnvDiff,
  maskSecretValue,
  mergeEnvStates,
  parseEnvValues,
  stripIgnoredKeys,
  updateKeyStateMap,
} from '../src/envMerge.js';

describe('envMerge', () => {
  it('parses .env values while preserving quoting and export syntax', () => {
    const content = [
      '# Database config',
      'DB_URL="postgres://localhost/app"',
      'export API_KEY=sk-12345',
      '',
      'EMPTY_VAL=',
    ].join('\n');

    expect(parseEnvValues(content)).toEqual({
      DB_URL: '"postgres://localhost/app"',
      API_KEY: 'sk-12345',
      EMPTY_VAL: '',
    });
  });

  it('strips ignored keys while keeping comments and other keys', () => {
    const content = '# Header\nPORT=3001\nAPI_KEY=abc\nLOCAL_ONLY=1\n';
    expect(stripIgnoredKeys(content, ['PORT', 'LOCAL_ONLY'])).toBe(
      '# Header\nAPI_KEY=abc\n',
    );
  });

  it('merges concurrent edits to different keys without wiping either peer', () => {
    const base = 'SHARED=1\n';
    const baseKeys = updateKeyStateMap({}, base, 1000);

    // Peer A adds STRIPE_KEY at t=2000
    const localContent = 'SHARED=1\nSTRIPE_KEY=sk_live_a\n';
    const localKeys = updateKeyStateMap(baseKeys, localContent, 2000);

    // Peer B concurrently adds REDIS_URL at t=2500 (without STRIPE_KEY)
    const remoteContent = 'SHARED=1\nREDIS_URL=redis://localhost\n';
    const remoteKeys = updateKeyStateMap(baseKeys, remoteContent, 2500);

    const result = mergeEnvStates({
      localContent,
      localKeys,
      remoteContent,
      remoteKeys,
    });

    expect(result.changedLocal).toBe(true);
    expect(result.localHasNewerKeys).toBe(true);
    expect(parseEnvValues(result.mergedContent)).toEqual({
      SHARED: '1',
      STRIPE_KEY: 'sk_live_a',
      REDIS_URL: 'redis://localhost',
    });
  });

  it('resolves same-key conflicts by latest per-key timestamp and propagates tombstones', () => {
    const baseKeys = updateKeyStateMap({}, 'A=1\nB=old\n', 1000);
    const localKeys = updateKeyStateMap(baseKeys, 'A=1\nB=local-newer\n', 3000);
    // Remote deleted A at t=2500 and modified B at t=2000 (older than local B)
    const remoteKeys = updateKeyStateMap(baseKeys, 'B=remote-older\n', 2500);
    remoteKeys.B = { value: 'remote-older', updatedAt: 2000 };

    const result = mergeEnvStates({
      localContent: 'A=1\nB=local-newer\n',
      localKeys,
      remoteContent: 'B=remote-older\n',
      remoteKeys,
    });

    expect(result.changedLocal).toBe(true);
    expect(result.localHasNewerKeys).toBe(true);
    expect(parseEnvValues(result.mergedContent)).toEqual({
      B: 'local-newer',
    });
  });

  it('preserves local ignoreKeys during merge', () => {
    const localContent = 'PORT=4000\nAPI_KEY=old\n';
    const localKeys = updateKeyStateMap({}, localContent, 1000, ['PORT']);
    const remoteContent = 'PORT=8080\nAPI_KEY=new\n';
    const remoteKeys = updateKeyStateMap({}, remoteContent, 2000);

    const result = mergeEnvStates({
      localContent,
      localKeys,
      remoteContent,
      remoteKeys,
      ignoreKeys: ['PORT'],
    });

    expect(parseEnvValues(result.mergedContent)).toEqual({
      PORT: '4000',
      API_KEY: 'new',
    });
  });

  it('masks secret values safely and computes key-level diffs', () => {
    expect(maskSecretValue('abc')).toBe('****');
    expect(maskSecretValue('abcdef')).toBe('a***f');
    expect(maskSecretValue('"sk-1234567890"')).toBe('sk-***90');

    const diffs = computeEnvDiff(
      'KEEP=1\nOLD=gone\nMOD=v1\nPORT=3000\n',
      'KEEP=1\nNEW=added\nMOD=v2\nPORT=9999\n',
      ['PORT'],
    );
    expect(diffs).toEqual([
      { key: 'MOD', kind: 'modified', localValue: 'v1', remoteValue: 'v2' },
      { key: 'NEW', kind: 'added', remoteValue: 'added' },
      { key: 'OLD', kind: 'removed', localValue: 'gone' },
    ]);
  });
});
