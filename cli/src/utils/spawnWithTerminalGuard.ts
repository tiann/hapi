import { restoreTerminalState } from '@/ui/terminalState';
import { releaseStdinForChild } from '@/utils/stdinLifecycle';
import { spawnWithAbort, type SpawnWithAbortOptions } from '@/utils/spawnWithAbort';

/**
 * Guards the terminal around a spawnWithAbort call: releases stdin before
 * spawn (pause() alone is not enough — Bun keeps a pending read on fd 0 that
 * starves the child; see stdinLifecycle), then resumes stdin and restores
 * terminal escape state in finally.
 */
export async function spawnWithTerminalGuard(options: SpawnWithAbortOptions): Promise<void> {
    releaseStdinForChild();
    try {
        await spawnWithAbort(options);
    } finally {
        if (!process.stdin.destroyed) {
            process.stdin.resume();
        }
        restoreTerminalState();
    }
}
