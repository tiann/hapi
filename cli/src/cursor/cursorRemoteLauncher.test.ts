import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Metadata } from '@hapi/protocol/schemas';
import type { CursorSession } from './session';

const legacyLauncher = vi.hoisted(() => vi.fn(async () => 'exit' as const));
const acpLauncher = vi.hoisted(() => vi.fn(async () => 'exit' as const));

vi.mock('./cursorLegacyRemoteLauncher', () => ({
    cursorLegacyRemoteLauncher: legacyLauncher
}));

vi.mock('./cursorAcpRemoteLauncher', () => ({
    cursorAcpRemoteLauncher: acpLauncher
}));

import { cursorRemoteLauncher } from './cursorRemoteLauncher';

const baseMetadata: Metadata = {
    flavor: 'cursor',
    path: '/tmp',
    host: 'test'
};

function makeSession(): CursorSession {
    return { path: '/tmp' } as CursorSession;
}

describe('cursorRemoteLauncher', () => {
    beforeEach(() => {
        legacyLauncher.mockClear();
        acpLauncher.mockClear();
        acpLauncher.mockResolvedValue('exit');
        legacyLauncher.mockResolvedValue('exit');
    });

    it('uses ACP launcher for new sessions without cursorSessionId', async () => {
        await cursorRemoteLauncher(makeSession(), baseMetadata);

        expect(acpLauncher).toHaveBeenCalledTimes(1);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('uses legacy launcher only when metadata marks a pre-ACP session', async () => {
        const legacyMetadata: Metadata = {
            ...baseMetadata,
            cursorSessionId: 'old-stream-json-id',
            cursorSessionProtocol: 'stream-json'
        };

        await cursorRemoteLauncher(makeSession(), legacyMetadata);

        expect(legacyLauncher).toHaveBeenCalledTimes(1);
        expect(acpLauncher).not.toHaveBeenCalled();
    });

    it('uses legacy launcher when cursorSessionId exists without protocol (pre-migration)', async () => {
        const legacyMetadata: Metadata = {
            ...baseMetadata,
            cursorSessionId: 'old-stream-json-id'
        };

        await cursorRemoteLauncher(makeSession(), legacyMetadata);

        expect(legacyLauncher).toHaveBeenCalledTimes(1);
        expect(acpLauncher).not.toHaveBeenCalled();
    });

    it('uses ACP launcher when cursorSessionProtocol is acp even with session id', async () => {
        const acpMetadata: Metadata = {
            ...baseMetadata,
            cursorSessionId: 'acp-session-id',
            cursorSessionProtocol: 'acp'
        };

        await cursorRemoteLauncher(makeSession(), acpMetadata);

        expect(acpLauncher).toHaveBeenCalledTimes(1);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('does not fallback to stream-json when the ACP launcher fails', async () => {
        acpLauncher.mockRejectedValueOnce(new Error('Cursor ACP unavailable'));

        await expect(cursorRemoteLauncher(makeSession(), baseMetadata)).rejects.toThrow('Cursor ACP unavailable');

        expect(acpLauncher).toHaveBeenCalledTimes(1);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });

    it('does not fallback to stream-json when ACP resume fails for an acp-marked session', async () => {
        const acpMetadata: Metadata = {
            ...baseMetadata,
            cursorSessionId: 'acp-session-id',
            cursorSessionProtocol: 'acp'
        };
        acpLauncher.mockRejectedValueOnce(new Error('Failed to resume Cursor ACP session'));

        await expect(cursorRemoteLauncher(makeSession(), acpMetadata)).rejects.toThrow('Failed to resume Cursor ACP session');

        expect(acpLauncher).toHaveBeenCalledTimes(1);
        expect(legacyLauncher).not.toHaveBeenCalled();
    });
});
