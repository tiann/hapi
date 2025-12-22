import { logger } from '@/ui/logger';
import type { AgentSessionBase } from './sessionBase';

export type LoopLauncher<TSession> = (session: TSession) => Promise<'switch' | 'exit'>;

export async function runLocalRemoteLoop<TSession extends AgentSessionBase<any>>(opts: {
    session: TSession;
    startingMode?: 'local' | 'remote';
    logTag: string;
    runLocal: LoopLauncher<TSession>;
    runRemote: LoopLauncher<TSession>;
}): Promise<void> {
    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';

    while (true) {
        logger.debug(`[${opts.logTag}] Iteration with mode: ${mode}`);

        if (mode === 'local') {
            const reason = await opts.runLocal(opts.session);
            if (reason === 'exit') {
                return;
            }

            mode = 'remote';
            opts.session.onModeChange(mode);
            continue;
        }

        if (mode === 'remote') {
            const reason = await opts.runRemote(opts.session);
            if (reason === 'exit') {
                return;
            }

            mode = 'local';
            opts.session.onModeChange(mode);
            continue;
        }
    }
}
