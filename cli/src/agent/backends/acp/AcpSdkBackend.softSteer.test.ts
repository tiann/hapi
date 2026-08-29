import { describe, expect, it, vi } from 'vitest';
import { AcpSdkBackend } from './AcpSdkBackend';

function makeBackend() {
    const backend = new AcpSdkBackend({ command: 'agent' });
    const backendInternal = backend as unknown as {
        activePromptRequests: number;
        acceptingSoftSteers: boolean;
        transport: {
            sendRequestWithDispatch: (method: string, params: unknown, options?: { timeoutMs?: number }) => {
                dispatched: Promise<void>;
                completed: Promise<unknown>;
            };
            sendNotification: (method: string, params: unknown) => void;
            close: () => Promise<void>;
        } | null;
        waitForSessionUpdateQuiet: (quietMs: number, timeoutMs: number) => Promise<void>;
        drainLateBuffers: () => Promise<void>;
        messageHandler: { drainBuffers: () => void } | null;
        responseCompleteResolvers: Array<() => void>;
    };
    return { backend, backendInternal };
}

describe('AcpSdkBackend soft steer (#888)', () => {
    it('beginSoftSteerPrompt sends a concurrent session/prompt without cancel', () => {
        const { backend, backendInternal } = makeBackend();
        const calls: Array<{ method: string; params: unknown }> = [];
        backendInternal.activePromptRequests = 1;
        backendInternal.acceptingSoftSteers = true;
        backendInternal.transport = {
            sendRequestWithDispatch: (method, params) => {
                calls.push({ method, params });
                return {
                    dispatched: Promise.resolve(),
                    completed: Promise.resolve({ stopReason: 'end_turn' })
                };
            },
            sendNotification: () => {},
            close: async () => {}
        };

        backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot now' }]);

        expect(calls).toEqual([{
            method: 'session/prompt',
            params: {
                sessionId: 'session-1',
                prompt: [{ type: 'text', text: 'pivot now' }]
            }
        }]);
    });

    it('beginSoftSteerPrompt counts the concurrent prompt and finishes it', async () => {
        const { backend, backendInternal } = makeBackend();
        backendInternal.activePromptRequests = 1;
        backendInternal.acceptingSoftSteers = true;
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({
                dispatched: Promise.resolve(),
                completed: Promise.resolve({ stopReason: 'end_turn' })
            }),
            sendNotification: () => {},
            close: async () => {}
        };

        const steer = backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'x' }]);
        expect(backendInternal.activePromptRequests).toBe(2);

        await steer.dispatched;
        await steer.completed;
        // The main prompt is still counted after the soft steer settles.
        expect(backendInternal.activePromptRequests).toBe(1);
    });

    it('rejects soft steer when no prompt is in flight', async () => {
        const { backend, backendInternal } = makeBackend();
        backendInternal.transport = {
            sendRequestWithDispatch: () => ({
                dispatched: Promise.resolve(),
                completed: Promise.resolve({ stopReason: 'end_turn' })
            }),
            sendNotification: () => {},
            close: async () => {}
        };
        expect(() => backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'x' }]))
            .toThrow('No active steerable turn');
    });

    it('seals soft-steer admission when the main prompt rejects', async () => {
        const { backend, backendInternal } = makeBackend();
        let releaseDrain!: () => void;
        const drainDeferred = new Promise<void>((resolve) => { releaseDrain = resolve; });
        let quietCalls = 0;
        backendInternal.waitForSessionUpdateQuiet = vi.fn(async () => {
            quietCalls += 1;
            if (quietCalls === 2) {
                await drainDeferred;
            }
        });
        backendInternal.drainLateBuffers = vi.fn(async () => {});
        backendInternal.messageHandler = { drainBuffers: vi.fn() };
        (backend as unknown as { transport: unknown }).transport = {
            sendRequest: vi.fn(async () => {
                throw new Error('main failed');
            }),
            sendRequestWithDispatch: vi.fn(),
            sendNotification: vi.fn(),
            close: vi.fn(async () => {})
        };

        const promptPromise = backend.prompt('session-1', [{ type: 'text', text: 'main' }], vi.fn())
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(quietCalls).toBe(2));

        expect(backendInternal.acceptingSoftSteers).toBe(false);
        expect(() => backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'late' }]))
            .toThrow('No active steerable turn');

        releaseDrain();
        await expect(promptPromise).resolves.toMatchObject({ message: 'main failed' });
    });
});

describe('AcpSdkBackend soft steer turn boundary (#888)', () => {
    it('seals the turn after the main response and emits the boundary only after concurrent steers settle', async () => {
        const backend = new AcpSdkBackend({ command: 'agent' });
        let releaseMain!: () => void;
        let releaseSteer!: () => void;
        const mainDeferred = new Promise<void>((resolve) => { releaseMain = resolve; });
        const steerDeferred = new Promise<void>((resolve) => { releaseSteer = resolve; });

        const transport = {
            sendRequest: vi.fn(async () => {
                await mainDeferred;
                return { stopReason: 'end_turn' };
            }),
            sendRequestWithDispatch: vi.fn(() => ({
                dispatched: Promise.resolve(),
                completed: steerDeferred.then(() => ({ stopReason: 'end_turn' }))
            })),
            sendNotification: vi.fn(),
            close: vi.fn(async () => {})
        };
        (backend as unknown as { transport: unknown }).transport = transport;

        const events: string[] = [];
        const promptPromise = backend.prompt('session-1', [{ type: 'text', text: 'main' }], (message) => {
            events.push(message.type);
        });

        // While the main prompt is in flight, a soft steer is accepted.
        await vi.waitFor(() => expect((backend as unknown as { activePromptRequests: number }).activePromptRequests).toBe(1));
        const steer = backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'pivot' }]);
        await steer.dispatched;
        await vi.waitFor(() => expect((backend as unknown as { activePromptRequests: number }).activePromptRequests).toBe(2));

        // The main response settles first; the turn seals.
        releaseMain();
        await vi.waitFor(() => expect((backend as unknown as { acceptingSoftSteers: boolean }).acceptingSoftSteers).toBe(false));

        // Sealed: new soft steers are rejected, and the boundary is not out yet.
        expect(() => backend.beginSoftSteerPrompt('session-1', [{ type: 'text', text: 'late' }]))
            .toThrow('No active steerable turn');
        expect(events).not.toContain('turn_complete');

        // Only when the concurrent steer settles does the turn boundary fire.
        releaseSteer();
        await steer.completed;
        await promptPromise;
        expect(events).toContain('turn_complete');
        expect(events.indexOf('turn_complete')).toBeGreaterThanOrEqual(0);
        // Both prompts fully finished.
        expect((backend as unknown as { activePromptRequests: number }).activePromptRequests).toBe(0);
    });
});
