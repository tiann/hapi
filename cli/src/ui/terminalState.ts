export function restoreTerminalState(): void {
    if (process.stdout.isTTY) {
        // Once the controlling terminal is gone (SIGHUP), the
        // slave-side fd can still read isTTY=true even though nothing reads
        // these writes anymore — write() against a dead tty can throw
        // synchronously (not just emit an async 'error'). Swallow it here so
        // a terminal-loss cleanup call never crashes the process it's trying
        // to shut down gracefully.
        try {
            // Disable kitty keyboard protocol / CSI u key release reporting if enabled.
            process.stdout.write('\x1b[>4;0m');
            // Disable focus reporting to avoid stray ^[[I on mode switches.
            process.stdout.write('\x1b[?1004l');
            process.stdout.write('\x1b[?2004l');
        } catch {
            // Ignore if the terminal is gone.
        }
    }
    if (process.stdin.isTTY) {
        try {
            process.stdin.setRawMode(false);
        } catch {
            // Ignore if raw mode is not supported.
        }
    }
}
