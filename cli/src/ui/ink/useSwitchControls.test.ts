import React, { useEffect } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSwitchControls, type ConfirmationMode, type ActionInProgress } from './useSwitchControls';

type Key = {
    ctrl?: boolean;
    name?: string;
    sequence?: string;
};

type SwitchState = {
    confirmationMode: ConfirmationMode;
    actionInProgress: ActionInProgress;
};

let inputHandler: ((input: string, key: Key) => void | Promise<void>) | null = null;

vi.mock('ink', () => ({
    useInput: (handler: (input: string, key: Key) => void | Promise<void>) => {
        inputHandler = handler;
    }
}));

function HookProbe(props: {
    onExit?: () => void;
    onSwitch?: () => void;
    onState: (state: SwitchState) => void;
}): null {
    const state = useSwitchControls({
        onExit: props.onExit,
        onSwitch: props.onSwitch,
        confirmationTimeoutMs: 5000
    });

    useEffect(() => {
        props.onState(state);
    }, [props.onState, state]);

    return null;
}

describe('useSwitchControls', () => {
    let renderer: ReactTestRenderer | null = null;
    let latestState: SwitchState | null = null;

    const mount = async (opts: { onExit?: () => void; onSwitch?: () => void }) => {
        await act(async () => {
            renderer = TestRenderer.create(
                React.createElement(HookProbe, {
                    ...opts,
                    onState: (state) => {
                        latestState = state;
                    }
                })
            );
        });
    };

    const triggerInput = async (input: string, key: Key) => {
        if (!inputHandler) {
            throw new Error('useInput handler was not registered');
        }
        await act(async () => {
            await inputHandler?.(input, key);
        });
    };

    const triggerInputWithTimers = async (input: string, key: Key, advanceMs: number) => {
        if (!inputHandler) {
            throw new Error('useInput handler was not registered');
        }
        await act(async () => {
            const promise = inputHandler?.(input, key);
            vi.advanceTimersByTime(advanceMs);
            await promise;
        });
    };

    const advanceTimers = async (advanceMs: number) => {
        await act(async () => {
            vi.advanceTimersByTime(advanceMs);
        });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        inputHandler = null;
        latestState = null;
    });

    afterEach(() => {
        if (renderer) {
            act(() => {
                renderer?.unmount();
            });
            renderer = null;
        }
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
    });

    it('forwards Ctrl-C to process when onExit is missing', async () => {
        const onSwitch = vi.fn();
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        await mount({ onSwitch });

        await triggerInput(' ', { name: 'space' });
        expect(latestState?.confirmationMode).toBe('switch');
        expect(latestState?.actionInProgress).toBe(null);
        expect(onSwitch).not.toHaveBeenCalled();

        await triggerInput('c', { ctrl: true });
        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
        expect(latestState?.confirmationMode).toBe(null);
        expect(latestState?.actionInProgress).toBe(null);
        killSpy.mockRestore();
    });

    it('confirms exit and invokes callback on second Ctrl-C', async () => {
        const onExit = vi.fn();
        await mount({ onExit });

        await triggerInput('c', { ctrl: true });
        expect(latestState?.confirmationMode).toBe('exit');
        expect(latestState?.actionInProgress).toBe(null);

        await triggerInputWithTimers('c', { ctrl: true }, 100);
        expect(latestState?.actionInProgress).toBe('exiting');
        expect(onExit).toHaveBeenCalledTimes(1);
    });

    it('ignores key-release sequences so confirmation stays visible', async () => {
        const onSwitch = vi.fn();
        await mount({ onSwitch });

        await triggerInput(' ', { name: 'space' });
        expect(latestState?.confirmationMode).toBe('switch');

        await triggerInput('', { sequence: '\u001b[1:3u' });
        expect(latestState?.confirmationMode).toBe('switch');
        expect(latestState?.actionInProgress).toBe(null);
    });

    it('does not switch on key-release space sequences', async () => {
        const onSwitch = vi.fn();
        await mount({ onSwitch });

        await triggerInput('', { sequence: '\u001b[3:3u', name: 'space' });
        expect(onSwitch).not.toHaveBeenCalled();
        expect(latestState?.confirmationMode).toBe(null);
    });

    it('clears confirmation after timeout', async () => {
        const onSwitch = vi.fn();
        await mount({ onSwitch });

        await triggerInput(' ', { name: 'space' });
        expect(latestState?.confirmationMode).toBe('switch');

        await advanceTimers(5000);
        expect(latestState?.confirmationMode).toBe(null);
    });
});
