import { logger } from '@/ui/logger';
import type { AgentSessionBase } from './sessionBase';

export type LoopLauncher<TSession> = (session: TSession) => Promise<'switch' | 'exit'>;

export async function runLocalRemoteSession<TSession extends AgentSessionBase<any>>(opts: {
    session: TSession;
    startingMode?: 'local' | 'remote';
    logTag: string;
    runLocal: LoopLauncher<TSession>;
    runRemote: LoopLauncher<TSession>;
    onSessionReady?: (session: TSession) => void;
}): Promise<void> {
    // Drain any identity work that completed before loop startup. The provider
    // launcher must still report and await its first real native identity; the
    // expected resume id is never synthetically confirmed here.
    await opts.session.waitForNativeIdentity();
    if (opts.onSessionReady) {
        opts.onSessionReady(opts.session);
    }

    await runLocalRemoteLoop({
        session: opts.session,
        startingMode: opts.startingMode,
        logTag: opts.logTag,
        runLocal: opts.runLocal,
        runRemote: opts.runRemote
    });
}

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
