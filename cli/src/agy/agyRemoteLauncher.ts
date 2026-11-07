import type { AgySession } from './session';
import { runLegacyStreamJsonAgy } from './legacyStreamJson';

/** Runs the remote agy session on the transport this agy release supports. */
export async function agyRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    return runLegacyStreamJsonAgy(session);
}
