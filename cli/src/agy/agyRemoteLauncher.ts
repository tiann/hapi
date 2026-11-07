import type { AgySession } from './session';
import { agyAcpRemoteLauncher } from './agyAcpRemoteLauncher';
import { selectLegacyStreamJsonAgy } from './legacyStreamJson';

export async function agyRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    const legacy = await selectLegacyStreamJsonAgy();
    if (legacy) return legacy(session);
    return agyAcpRemoteLauncher(session);
}
