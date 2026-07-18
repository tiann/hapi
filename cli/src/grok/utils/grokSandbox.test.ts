import { describe, expect, it } from 'vitest';
import type { GrokPermissionMode } from '@hapi/protocol/types';
import { getGrokSandboxProfile, hasSameGrokSandboxProfile } from './grokSandbox';

describe('getGrokSandboxProfile', () => {
    it.each([
        ['default', 'workspace'],
        ['read-only', 'read-only'],
        ['safe-yolo', 'workspace'],
        ['yolo', 'off']
    ] satisfies Array<[GrokPermissionMode, string]>)('maps %s to %s', (mode, expected) => {
        expect(getGrokSandboxProfile(mode)).toBe(expected);
    });

    it('detects whether a runtime permission change preserves the native sandbox profile', () => {
        expect(hasSameGrokSandboxProfile('default', 'safe-yolo')).toBe(true);
        expect(hasSameGrokSandboxProfile('safe-yolo', 'default')).toBe(true);
        expect(hasSameGrokSandboxProfile('default', 'read-only')).toBe(false);
        expect(hasSameGrokSandboxProfile('read-only', 'yolo')).toBe(false);
    });
});
