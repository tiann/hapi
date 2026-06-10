import type { Metadata } from '@hapi/protocol/schemas';
import type { CursorSession } from './session';
import { cursorAcpRemoteLauncher } from './cursorAcpRemoteLauncher';
import { cursorLegacyRemoteLauncher } from './cursorLegacyRemoteLauncher';
import { resolveCursorRemoteProtocol } from './utils/cursorProtocol';

export async function cursorRemoteLauncher(
    session: CursorSession,
    metadata?: Metadata | null
): Promise<'switch' | 'exit'> {
    const protocol = resolveCursorRemoteProtocol(metadata);
    if (protocol === 'stream-json') {
        return cursorLegacyRemoteLauncher(session);
    }
    return cursorAcpRemoteLauncher(session);
}
