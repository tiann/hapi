import { logger } from '@/ui/logger';
import type { AgentSessionBase } from './sessionBase';

export type LoopLauncher<TSession> = (session: TSession) => Promise<'switch' | 'exit'>;

export type SessionMode = 'local' | 'remote' | 'pty';

export async function runLocalRemoteSession<TSession extends AgentSessionBase<any>>(opts: {
    session: TSession;
    startingMode?: SessionMode;
    logTag: string;
    runLocal: LoopLauncher<TSession>;
    runRemote: LoopLauncher<TSession>;
    runPty?: LoopLauncher<TSession>;
    onSessionReady?: (session: TSession) => void;
}): Promise<void> {
    if (opts.onSessionReady) {
        opts.onSessionReady(opts.session);
    }

    await runLocalRemoteLoop({
        session: opts.session,
        startingMode: opts.startingMode,
        logTag: opts.logTag,
        runLocal: opts.runLocal,
        runRemote: opts.runRemote,
        runPty: opts.runPty,
    });
}

export async function runLocalRemoteLoop<TSession extends AgentSessionBase<any>>(opts: {
    session: TSession;
    startingMode?: SessionMode;
    logTag: string;
    runLocal: LoopLauncher<TSession>;
    runRemote: LoopLauncher<TSession>;
    runPty?: LoopLauncher<TSession>;
}): Promise<void> {
    let mode: SessionMode = opts.startingMode ?? 'local';

    while (true) {
        logger.debug(`[${opts.logTag}] Iteration with mode: ${mode}`);

        if (mode === 'local') {
            const reason = await opts.runLocal(opts.session);
            if (reason === 'exit') {
                return;
            }

            // Leaving local mode returns to this session's remote variant. PTY
            // is OPT-IN: only a session that started in PTY mode hands off to the
            // PTY launcher. A normal local/remote session must still use the SDK
            // remote launcher even though claude always registers a runPty
            // launcher (so `opts.runPty` is truthy for every claude session).
            mode = opts.startingMode === 'pty' && opts.runPty ? 'pty' : 'remote';
            opts.session.onModeChange(mode === 'pty' ? 'remote' : mode);
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

        if (mode === 'pty') {
            if (!opts.runPty) {
                throw new Error('PTY mode selected but no runPty launcher provided');
            }

            const reason = await opts.runPty(opts.session);
            if (reason === 'exit') {
                return;
            }

            mode = 'local';
            opts.session.onModeChange(mode);
            continue;
        }
    }
}
