import { describe, expect, it } from 'vitest';
import { isLegacyCursorSession, resolveCursorRemoteProtocol } from './cursorProtocol';

const baseMetadata = { flavor: 'cursor', path: '/tmp', host: 'test' };

describe('cursorProtocol', () => {
    it('routes new sessions to ACP', () => {
        expect(resolveCursorRemoteProtocol(baseMetadata)).toBe('acp');
        expect(isLegacyCursorSession(baseMetadata)).toBe(false);
    });

    it('routes legacy stream-json sessions by metadata', () => {
        const metadata = {
            ...baseMetadata,
            cursorSessionId: 'old-session',
            cursorSessionProtocol: 'stream-json' as const
        };
        expect(resolveCursorRemoteProtocol(metadata)).toBe('stream-json');
        expect(isLegacyCursorSession(metadata)).toBe(true);
    });

    it('routes sessions with cursorSessionId but no protocol to legacy', () => {
        const metadata = {
            ...baseMetadata,
            cursorSessionId: 'old-session'
        };
        expect(resolveCursorRemoteProtocol(metadata)).toBe('stream-json');
    });

    it('routes explicit ACP metadata to ACP even with session id', () => {
        const metadata = {
            ...baseMetadata,
            cursorSessionId: 'acp-session',
            cursorSessionProtocol: 'acp' as const
        };
        expect(resolveCursorRemoteProtocol(metadata)).toBe('acp');
        expect(isLegacyCursorSession(metadata)).toBe(false);
    });

    it('never treats non-cursor flavor as legacy', () => {
        expect(isLegacyCursorSession({ ...baseMetadata, flavor: 'claude', cursorSessionId: 'x' })).toBe(false);
        expect(resolveCursorRemoteProtocol({ ...baseMetadata, flavor: 'claude', cursorSessionId: 'x' })).toBe('acp');
    });

    it('does not use legacy when stream-json protocol is set but cursorSessionId is missing', () => {
        const metadata = {
            ...baseMetadata,
            cursorSessionProtocol: 'stream-json' as const
        };
        expect(isLegacyCursorSession(metadata)).toBe(false);
        expect(resolveCursorRemoteProtocol(metadata)).toBe('acp');
    });

    it('defaults null/undefined metadata to ACP (new session)', () => {
        expect(resolveCursorRemoteProtocol(null)).toBe('acp');
        expect(resolveCursorRemoteProtocol(undefined)).toBe('acp');
    });
});

