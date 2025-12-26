export function restoreTerminalState(): void {
    if (process.stdout.isTTY) {
        // Disable kitty keyboard protocol / CSI u key release reporting if enabled.
        process.stdout.write('\x1b[>4;0m');
        // Disable focus reporting to avoid stray ^[[I on mode switches.
        process.stdout.write('\x1b[?1004l');
        process.stdout.write('\x1b[?2004l');
    }
    if (process.stdin.isTTY) {
        try {
            process.stdin.setRawMode(false);
        } catch {
            // Ignore if raw mode is not supported.
        }
    }
}
