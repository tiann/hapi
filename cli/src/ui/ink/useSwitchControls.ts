import { useCallback, useEffect, useRef, useState } from 'react';
import { useInput, type Key } from 'ink';

// Ink's Key type is incomplete - these properties exist at runtime but aren't typed
type ExtendedKey = Key & {
    sequence?: string;
    name?: string;
};

export type ConfirmationMode = 'exit' | 'switch' | null;
export type ActionInProgress = 'exiting' | 'switching' | null;

export function useSwitchControls(opts: {
    onExit?: () => void;
    onSwitch?: () => void;
    confirmationTimeoutMs?: number;
}): {
    confirmationMode: ConfirmationMode;
    actionInProgress: ActionInProgress;
} {
    const [confirmationMode, setConfirmationMode] = useState<ConfirmationMode>(null);
    const [actionInProgress, setActionInProgress] = useState<ActionInProgress>(null);
    const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const { onExit, onSwitch } = opts;
    const confirmationTimeoutMs = opts.confirmationTimeoutMs ?? 15000;

    const resetConfirmation = useCallback(() => {
        setConfirmationMode(null);
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current);
            confirmationTimeoutRef.current = null;
        }
    }, []);

    const setConfirmationWithTimeout = useCallback((mode: Exclude<ConfirmationMode, null>) => {
        setConfirmationMode(mode);
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current);
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation();
        }, confirmationTimeoutMs);
    }, [confirmationTimeoutMs, resetConfirmation]);

    const readKeyString = useCallback((keyLike: unknown, prop: 'name' | 'sequence'): string | undefined => {
        if (!keyLike || typeof keyLike !== 'object') return undefined;
        if (!(prop in keyLike)) return undefined;
        const value = (keyLike as Record<string, unknown>)[prop];
        return typeof value === 'string' ? value : undefined;
    }, []);

    useEffect(() => {
        return () => {
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current);
            }
        };
    }, []);

    useInput(useCallback(async (input, key: ExtendedKey) => {
        if (actionInProgress) {
            return;
        }

        if (key.ctrl && input === 'c') {
            if (!onExit) {
                if (confirmationMode) {
                    resetConfirmation();
                }
                try {
                    process.kill(process.pid, 'SIGINT');
                } catch {
                    process.exit(130);
                }
                return;
            }
            if (confirmationMode === 'exit') {
                resetConfirmation();
                setActionInProgress('exiting');
                await new Promise(resolve => setTimeout(resolve, 100));
                onExit();
            } else {
                setConfirmationWithTimeout('exit');
            }
            return;
        }

        const keySequence = readKeyString(key, 'sequence');
        const keyName = readKeyString(key, 'name');
        const sequence = keySequence ?? input;
        const isKeyRelease = /^\u001b\[[0-9;]*:3u$/.test(sequence);
        const csiUMatch = sequence.match(/^\u001b\[(\d+)(?:;(\d+))?u$/);
        const csiUCodepoint = csiUMatch ? Number(csiUMatch[1]) : null;
        const isCsiUSpace = csiUCodepoint === 32;
        const isSpace = Boolean(onSwitch) && !isKeyRelease && (input === ' ' || keyName === 'space' || isCsiUSpace);
        const hasPrintableInput = typeof input === 'string' && input.length > 0;

        if (isSpace) {
            if (confirmationMode === 'switch') {
                resetConfirmation();
                setActionInProgress('switching');
                await new Promise(resolve => setTimeout(resolve, 100));
                onSwitch?.();
            } else {
                setConfirmationWithTimeout('switch');
            }
            return;
        }

        if (confirmationMode && hasPrintableInput && !isKeyRelease) {
            resetConfirmation();
        }
    }, [
        actionInProgress,
        confirmationMode,
        onExit,
        onSwitch,
        resetConfirmation,
        setConfirmationWithTimeout
    ]));

    return {
        confirmationMode,
        actionInProgress
    };
}
