import type { Metadata } from '@hapi/protocol/schemas';

export type CursorSessionProtocol = 'acp' | 'stream-json';

export function isLegacyCursorSession(metadata: Metadata | null | undefined): boolean {
    if (metadata?.flavor !== 'cursor') {
        return false;
    }
    if (metadata.cursorSessionProtocol === 'acp') {
        return false;
    }
    if (metadata.cursorSessionProtocol === 'stream-json') {
        return Boolean(metadata.cursorSessionId);
    }
    return Boolean(metadata.cursorSessionId);
}

export function resolveCursorRemoteProtocol(metadata: Metadata | null | undefined): CursorSessionProtocol {
    if (isLegacyCursorSession(metadata)) {
        return 'stream-json';
    }
    return 'acp';
}
