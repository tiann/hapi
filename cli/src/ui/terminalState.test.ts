import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTerminalInputModes, restoreTerminalState } from './terminalState';

const resetSequence = '\x1b[<u\x1b[=0;1u\x1b[>4;0m\x1b[?1004l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';

describe('terminal input state', () => {
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');

    afterEach(() => {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
        if (originalSetRawMode) {
            Object.defineProperty(process.stdin, 'setRawMode', originalSetRawMode);
        } else {
            Reflect.deleteProperty(process.stdin, 'setRawMode');
        }
        vi.restoreAllMocks();
    });

    it('clears keyboard, focus, paste, and mouse reporting modes', () => {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        resetTerminalInputModes();

        expect(writeSpy).toHaveBeenCalledWith(resetSequence);
    });

    it('resets input modes before leaving raw mode', () => {
        Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stdin, 'setRawMode', {
            configurable: true,
            value: () => process.stdin
        });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const rawModeSpy = vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);

        restoreTerminalState();

        expect(writeSpy.mock.invocationCallOrder[0])
            .toBeLessThan(rawModeSpy.mock.invocationCallOrder[0]);
        expect(rawModeSpy).toHaveBeenCalledWith(false);
    });
});
