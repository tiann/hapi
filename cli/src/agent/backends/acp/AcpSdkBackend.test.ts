import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { AcpSdkBackend } from './AcpSdkBackend';
import { ACP_SESSION_UPDATE_TYPES } from './constants';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type BackendStatics = {
    UPDATE_QUIET_PERIOD_MS: number;
    UPDATE_DRAIN_TIMEOUT_MS: number;
    PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: number;
    PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: number;
};

const backendStatics = AcpSdkBackend as unknown as BackendStatics;
const originalStatics = {
    updateQuietPeriodMs: backendStatics.UPDATE_QUIET_PERIOD_MS,
    updateDrainTimeoutMs: backendStatics.UPDATE_DRAIN_TIMEOUT_MS,
    prePromptUpdateQuietPeriodMs: backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
    prePromptUpdateDrainTimeoutMs: backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
};

afterEach(() => {
    backendStatics.UPDATE_QUIET_PERIOD_MS = originalStatics.updateQuietPeriodMs;
    backendStatics.UPDATE_DRAIN_TIMEOUT_MS = originalStatics.updateDrainTimeoutMs;
    backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = originalStatics.prePromptUpdateQuietPeriodMs;
    backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = originalStatics.prePromptUpdateDrainTimeoutMs;
});

describe('AcpSdkBackend', () => {
    it('treats a successful ACP session/load response as confirmation of the requested native id', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async () => ({}),
            close: async () => {}
        };

        await expect(backend.loadSession({
            sessionId: 'requested-session',
            cwd: '/tmp',
            mcpServers: []
        })).resolves.toBe('requested-session');
    });

    it('rejects a conflicting provider extension id in the session/load response', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
        };
        backendInternal.transport = {
            sendRequest: async () => ({ sessionId: 'different-session' }),
            close: async () => {}
        };

        await expect(backend.loadSession({
            sessionId: 'requested-session',
            cwd: '/tmp',
            mcpServers: []
        })).rejects.toThrow('conflicting native session id');
    });

    it('allows the permission handler to resolve requests immediately', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        let capturedRequestId: string | null = null;

        backend.onPermissionRequest((request) => {
            capturedRequestId = request.id;
            void backend.respondToPermission(request.sessionId, request, {
                outcome: 'selected',
                optionId: 'allow-once'
            });
        });

        const backendInternal = backend as unknown as {
            handlePermissionRequest: (params: unknown, requestId: string | number | null) => Promise<unknown>;
        };

        await expect(backendInternal.handlePermissionRequest({
            sessionId: 'session-1',
            toolCall: {
                toolCallId: 'tool-approve',
                title: 'hapi_change_title',
                rawInput: { title: 'Rename chat' }
            },
            options: [
                {
                    optionId: 'allow-once',
                    name: 'Allow once',
                    kind: 'allow_once'
                }
            ]
        }, null)).resolves.toEqual({
            outcome: {
                outcome: 'selected',
                optionId: 'allow-once'
            }
        });

        expect(capturedRequestId).toBe('tool-approve');
    });

    it('emits turn_complete after trailing tool updates from the same turn', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 20;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };

        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
                            content: { type: 'text', text: 'final answer' }
                        }
                    });
                }, 0);

                // Make the last already-delivered update older than the quiet
                // period before the response resolves. A correct post-response
                // drain must still wait for notifications queued immediately
                // before that response instead of declaring the turn quiet from
                // the stale timestamp.
                await sleep(30);

                // Schedule the trailing updates before returning, but let them
                // run on the next macrotask. That keeps the test focused on the
                // post-response drain behavior without relying on very tight
                // millisecond timers that can lose races under full-suite load.
                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                            toolCallId: 'tool-1',
                            title: 'Read',
                            rawInput: { path: 'README.md' },
                            status: 'in_progress'
                        }
                    });
                }, 0);

                setTimeout(() => {
                    backendInternal.handleSessionUpdate({
                        sessionId: 'session-1',
                        update: {
                            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                            toolCallId: 'tool-1',
                            status: 'completed',
                            rawOutput: { ok: true }
                        }
                    });
                }, 0);

                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-1', [{ type: 'text', text: 'hello' }], (message) => {
            messages.push(message);
        });

        expect(messages.map((message) => message.type)).toEqual([
            'tool_call',
            'tool_result',
            'text',
            'turn_complete'
        ]);
    });

    it('does not accept timer quiet before a trailing update already queued for the check phase', async () => {
        backendStatics.UPDATE_QUIET_PERIOD_MS = 10;
        backendStatics.UPDATE_DRAIN_TIMEOUT_MS = 200;
        backendStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
        backendStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;

        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendInternal = backend as unknown as {
            transport: {
                sendRequest: (...args: unknown[]) => Promise<unknown>;
                close: () => Promise<void>;
            } | null;
            handleSessionUpdate: (params: unknown) => void;
        };
        const messages: AgentMessage[] = [];
        backendInternal.transport = {
            sendRequest: async () => {
                // This callback represents stdout already readable for the next
                // poll/check turn. The timer callback below stalls long enough
                // for the quiet timer to become overdue before check runs.
                setImmediate(() => {
                    const blockedUntil = Date.now() + 30;
                    while (Date.now() < blockedUntil) {
                        // Deliberately block this test's event loop.
                    }
                    setImmediate(() => {
                        backendInternal.handleSessionUpdate({
                            sessionId: 'session-stalled',
                            update: {
                                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                                toolCallId: 'queued-tool',
                                title: 'Queued read',
                                status: 'in_progress'
                            }
                        });
                    });
                }, 0);
                return { stopReason: 'end_turn' };
            },
            close: async () => {}
        };

        await backend.prompt('session-stalled', [{ type: 'text', text: 'hello' }], (message) => {
            messages.push(message);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(messages.map((message) => message.type)).toEqual(['tool_call', 'turn_complete']);
    });

    it('publishes unexpected terminal state but suppresses explicit disconnect', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const terminalErrors: Error[] = [];
        const backendLifecycle = backend as unknown as {
            transport: {
                isOpen: () => boolean;
                close: () => Promise<void>;
            } | null;
            onTerminalError: (handler: (error: Error) => void) => void;
            isConnected: () => boolean;
            handleTransportTerminal: (transport: unknown, error: Error) => void;
        };
        const unexpectedTransport = {
            isOpen: () => false,
            close: async () => {}
        };
        backendLifecycle.transport = unexpectedTransport;
        backendLifecycle.onTerminalError((error) => terminalErrors.push(error));

        backendLifecycle.handleTransportTerminal(unexpectedTransport, new Error('provider exited'));

        expect(terminalErrors.map((error) => error.message)).toEqual(['provider exited']);
        expect(backendLifecycle.isConnected()).toBe(false);

        const expectedTransport = {
            isOpen: () => true,
            close: async () => {
                backendLifecycle.handleTransportTerminal(expectedTransport, new Error('ACP transport closed'));
            }
        };
        backendLifecycle.transport = expectedTransport;

        await backend.disconnect();

        expect(terminalErrors.map((error) => error.message)).toEqual(['provider exited']);
    });

    it('retains an unexpectedly terminal transport long enough to reap it during cleanup', async () => {
        const backend = new AcpSdkBackend({ command: 'opencode' });
        const backendLifecycle = backend as unknown as {
            transport: {
                isOpen: () => boolean;
                close: () => Promise<void>;
            } | null;
            handleTransportTerminal: (transport: unknown, error: Error) => void;
        };
        let closeCalls = 0;
        const transport = {
            isOpen: () => false,
            close: async () => {
                closeCalls += 1;
            }
        };
        backendLifecycle.transport = transport;

        backendLifecycle.handleTransportTerminal(transport, new Error('stdin failed'));
        await backend.disconnect();

        expect(closeCalls).toBe(1);
    });
});
