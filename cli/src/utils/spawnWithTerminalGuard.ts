import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort, type SpawnWithAbortOptions } from '@/utils/spawnWithAbort';

/**
 * Guards the terminal around a spawnWithAbort call: pauses stdin before spawn,
 * then resumes stdin and restores terminal escape state in finally.
 *
 * Once the controlling terminal is
 * gone, stdin.resume() / restoreTerminalState() can themselves throw against
 * the dead tty. Each cleanup step is isolated in its own try/catch so a
 * teardown failure never masks a successful spawn or replaces the real
 * spawn error the caller actually needs to see.
 */
export async function spawnWithTerminalGuard(options: SpawnWithAbortOptions): Promise<void> {
    process.stdin.pause();
    try {
        await spawnWithAbort(options);
    } finally {
        try {
            process.stdin.resume();
        } catch (error) {
            logger.debug('[spawnWithTerminalGuard] stdin.resume() failed', error);
        }
        try {
            restoreTerminalState();
        } catch (error) {
            logger.debug('[spawnWithTerminalGuard] restoreTerminalState() failed', error);
        }
    }
}
