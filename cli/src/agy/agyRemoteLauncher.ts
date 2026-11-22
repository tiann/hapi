import type { AgySession } from './session';
import { AgyAcpStartError, agyAcpRemoteLauncher } from './agyAcpRemoteLauncher';
import { runStreamJsonAgyAfterAcpFailure, selectLegacyStreamJsonAgy } from './legacyStreamJson';

export async function agyRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    if (session.client.getMetadata?.()?.agyImportedAt != null) return agyAcpRemoteLauncher(session);
    const legacy = await selectLegacyStreamJsonAgy();
    if (legacy) return legacy(session);
    try {
        return await agyAcpRemoteLauncher(session);
    } catch (error) {
        if (!(error instanceof AgyAcpStartError)) throw error;
        return runStreamJsonAgyAfterAcpFailure(session, error);
    }
}
