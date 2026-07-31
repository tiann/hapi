const RESET_INPUT_MODES = [
    '\x1b[<u',
    '\x1b[=0;1u',
    '\x1b[>4;0m',
    '\x1b[?1004l',
    '\x1b[?2004l',
    '\x1b[?1000l',
    '\x1b[?1002l',
    '\x1b[?1003l',
    '\x1b[?1006l'
].join('');

export function resetTerminalInputModes(): void {
    if (process.stdout.isTTY) {
        process.stdout.write(RESET_INPUT_MODES);
    }
}

export function restoreTerminalState(): void {
    resetTerminalInputModes();
    if (process.stdin.isTTY) {
        try {
            process.stdin.setRawMode(false);
        } catch {
            // Ignore if raw mode is not supported.
        }
    }
}
