import React, { act, useEffect } from 'react';
import { PassThrough } from 'node:stream';
import { render, type Instance } from 'ink';
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

vi.mock('ink', async () => {
    const actual = await vi.importActual<typeof import('ink')>('ink');
    return {
        ...actual,
        useInput: (handler: (input: string, key: Key) => void | Promise<void>) => {
            inputHandler = handler;
        }
    };
});

const createInkStreams = (): {
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
    stdin: NodeJS.ReadStream;
} => {
    const stdout = new PassThrough() as NodeJS.WriteStream & {
        isTTY?: boolean;
        columns?: number;
        rows?: number;
    };
    const stderr = new PassThrough() as NodeJS.WriteStream & {
        isTTY?: boolean;
        columns?: number;
        rows?: number;
    };
    const stdin = new PassThrough() as NodeJS.ReadStream & {
        isTTY?: boolean;
    };

    Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 });
    Object.assign(stderr, { isTTY: true, columns: 80, rows: 24 });
    Object.assign(stdin, { isTTY: false });

    return { stdout, stderr, stdin };
};

const getActEnvironment = (): boolean | undefined =>
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

const setActEnvironment = (value: boolean | undefined) => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
};

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
    let renderer: Instance | null = null;
    let latestState: SwitchState | null = null;
    let previousActEnvironment: boolean | undefined;

    const mount = async (opts: { onExit?: () => void; onSwitch?: () => void }) => {
        const { stdout, stderr, stdin } = createInkStreams();
        await act(async () => {
            renderer = render(
                React.createElement(HookProbe, {
                    ...opts,
                    onState: (state) => {
                        latestState = state;
                    }
                }),
                {
                    stdout,
                    stderr,
                    stdin,
                    exitOnCtrlC: false,
                    patchConsole: false
                }
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
        previousActEnvironment = getActEnvironment();
        setActEnvironment(true);
        vi.useFakeTimers();
        inputHandler = null;
        latestState = null;
    });

    afterEach(async () => {
        await act(async () => {
            vi.runOnlyPendingTimers();
        });
        if (renderer) {
            await act(async () => {
                renderer.unmount();
            });
            renderer.cleanup();
            renderer = null;
        }
        vi.useRealTimers();
        setActEnvironment(previousActEnvironment);
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
