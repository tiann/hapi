import tty from 'node:tty';
import { logger } from '@/ui/logger';

// Why this module exists:
// Bun's tty.ReadStream keeps an in-flight read on fd 0 even after pause()
// (https://github.com/oven-sh/bun/issues/29126). When a session switches from
// remote mode back to local mode, the agent TUI is spawned with
// stdio:'inherit' and races that stale read for console input — and loses.
// The TUI renders but no keystroke ever reaches it.
// The only reliable way to stop the read under Bun is to destroy the stdin
// stream outright; remote mode re-creates it via ensureLiveStdin() when it
// starts up again.

/**
 * Stop consuming stdin so a child spawned with stdio:'inherit' gets all
 * console input. Destroys the stream because pause() alone leaves a pending
 * read under Bun.
 */
export function releaseStdinForChild(): void {
    try {
        process.stdin.pause();
    } catch {
    }
    // Destroying is only needed for a TTY (Bun's stale pending read). For
    // piped stdin, destroy() would close fd 0 and starve a child spawned
    // with stdio:'inherit'; pause() is sufficient there.
    if (process.stdin.destroyed || !process.stdin.isTTY) {
        return;
    }
    try {
        process.stdin.destroy();
    } catch (error) {
        logger.debug('[stdinLifecycle] Failed to destroy stdin', error);
    }
}

/**
 * Re-create process.stdin from fd 0 after releaseStdinForChild() destroyed
 * it. No-op when stdin is still alive or fd 0 is not a terminal (remote mode
 * without a TTY never reads stdin).
 */
export function ensureLiveStdin(): void {
    if (!process.stdin.destroyed) {
        return;
    }
    if (!tty.isatty(0)) {
        return;
    }
    try {
        const fresh = new tty.ReadStream(0);
        Object.defineProperty(process, 'stdin', {
            value: fresh,
            writable: true,
            configurable: true
        });
        logger.debug('[stdinLifecycle] Re-created process.stdin from fd 0');
    } catch (error) {
        logger.debug('[stdinLifecycle] Failed to re-create stdin', error);
    }
}
