import { describe, expect, it } from 'vitest';
import {
  isValidRoomId,
  parseClientMessage,
  parseServerMessage,
} from '../src/protocol.js';

describe('protocol', () => {
  describe('isValidRoomId', () => {
    it('accepts valid room IDs', () => {
      expect(isValidRoomId('A7K9-M2P4-X8Q3')).toBe(true);
      expect(isValidRoomId('team_dev_1')).toBe(true);
      expect(isValidRoomId('ABC')).toBe(true);
    });

    it('rejects invalid room IDs', () => {
      expect(isValidRoomId('')).toBe(false);
      expect(isValidRoomId('ab')).toBe(false);
      expect(isValidRoomId('room with spaces')).toBe(false);
      expect(isValidRoomId('../etc/passwd')).toBe(false);
      expect(isValidRoomId('a'.repeat(65))).toBe(false);
      expect(isValidRoomId(12345)).toBe(false);
    });
  });

  describe('parseClientMessage', () => {
    it('parses valid join, request_state, and sync messages', () => {
      expect(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'ROOM-1' }))).toEqual({
        type: 'join',
        roomId: 'ROOM-1',
      });
      expect(
        parseClientMessage(JSON.stringify({ type: 'request_state', roomId: 'ROOM-1' })),
      ).toEqual({
        type: 'request_state',
        roomId: 'ROOM-1',
      });
      expect(
        parseClientMessage(
          JSON.stringify({
            type: 'sync',
            roomId: 'ROOM-1',
            payload: 'iv:tag:ct',
            timestamp: 123456,
          }),
        ),
      ).toEqual({
        type: 'sync',
        roomId: 'ROOM-1',
        payload: 'iv:tag:ct',
        timestamp: 123456,
      });
    });

    it('rejects malformed or invalid client messages', () => {
      expect(parseClientMessage('not-json')).toBeNull();
      expect(parseClientMessage(JSON.stringify({ type: 'sync', roomId: 'ROOM-1' }))).toBeNull();
      expect(parseClientMessage(JSON.stringify({ type: 'unknown', roomId: 'ROOM-1' }))).toBeNull();
      expect(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'x' }))).toBeNull();
    });
  });

  describe('parseServerMessage', () => {
    it('parses valid server messages', () => {
      expect(
        parseServerMessage(
          JSON.stringify({ type: 'update', payload: 'iv:tag:ct', timestamp: 999 }),
        ),
      ).toEqual({ type: 'update', payload: 'iv:tag:ct', timestamp: 999 });

      expect(
        parseServerMessage(
          JSON.stringify({ type: 'peer_count', roomId: 'ROOM-1', count: 3 }),
        ),
      ).toEqual({ type: 'peer_count', roomId: 'ROOM-1', count: 3 });

      expect(
        parseServerMessage(JSON.stringify({ type: 'error', message: 'bad' })),
      ).toEqual({ type: 'error', message: 'bad' });
    });

    it('rejects invalid server messages', () => {
      expect(parseServerMessage('{')).toBeNull();
      expect(parseServerMessage(JSON.stringify({ type: 'update' }))).toBeNull();
    });
  });
});
