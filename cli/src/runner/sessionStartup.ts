import type { SpawnSessionResult } from '@/modules/common/rpcTypes';
import type { ChildProcess } from 'node:child_process';

/** A failed startup may still own a live process using its working directory. */
export function cleanupFailedStartupAfterExit(
    child: Pick<ChildProcess, 'exitCode' | 'signalCode'> & { once(event: 'exit', listener: () => void): unknown },
    shouldCleanup: () => boolean,
    cleanup: () => void,
): void {
    const onExit = () => { if (shouldCleanup()) cleanup(); };
    if (child.exitCode !== null || child.signalCode !== null) onExit();
    else child.once('exit', onExit);
}

export function sessionStartupTimeout(agent: string | undefined, configured?: string): number {
    const explicit = Number(configured);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return agent === 'codex' ? 30_000 : 15_000;
}

/** A caller's deadline does not prove that a shared execution failed to start. */
export function waitForRecoverableStartup<T>(options: {
    timeoutMs: number;
    timeoutMessage: string;
    sessionId: (session: T) => string;
    onLateReady: (session: T) => void;
    onLateFailure?: (errorMessage: string) => void;
}) {
    let phase: 'waiting' | 'unconfirmed' | 'finished' = 'waiting';
    let resolve!: (result: SpawnSessionResult) => void;
    const result = new Promise<SpawnSessionResult>(done => { resolve = done; });
    const timer = setTimeout(() => {
        if (phase !== 'waiting') return;
        phase = 'unconfirmed';
        resolve({ type: 'error', errorMessage: options.timeoutMessage });
    }, options.timeoutMs);
    return {
        result,
        confirm(session: T): void {
            if (phase === 'finished') return;
            const late = phase === 'unconfirmed';
            phase = 'finished'; clearTimeout(timer);
            if (late) options.onLateReady(session);
            resolve({ type: 'success', sessionId: options.sessionId(session) });
        },
        fail(errorMessage: string): void {
            if (phase === 'finished') return;
            const late = phase === 'unconfirmed';
            phase = 'finished'; clearTimeout(timer);
            if (late) options.onLateFailure?.(errorMessage);
            resolve({ type: 'error', errorMessage });
        },
    };
}
