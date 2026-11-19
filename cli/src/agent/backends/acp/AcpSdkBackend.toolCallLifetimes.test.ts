import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AgentMessage, FormElicitationResponse, PermissionRequest } from '@/agent/types';
import { OpencodePermissionHandler } from '@/opencode/utils/permissionHandler';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { AcpSdkBackend } from './AcpSdkBackend';
import { ACP_SESSION_UPDATE_TYPES } from './constants';
import { createFileToolCallLifetimeStore, type ToolCallLifetimeStore } from './toolCallLifetimeStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredToolCallLifetime } from './toolCallLifetimes';

// Some agents reuse tool call ids every turn (`question:0`,
// `shell:0`). HAPI must give every call lifetime its own id, end to end.

type BackendInternal = {
    transport: {
        sendRequest: (method: string, params: unknown) => Promise<unknown>;
        sendNotification: (method: string, params: unknown) => void;
        close: () => Promise<void>;
    } | null;
    handleNotification: (method: string, params: unknown) => void;
    handlePermissionRequest: (params: unknown, requestId: string | number | null) => Promise<unknown>;
    handleElicitationRequest: (params: unknown) => Promise<FormElicitationResponse>;
};

type BackendStatics = Record<
    'UPDATE_QUIET_PERIOD_MS' | 'UPDATE_DRAIN_TIMEOUT_MS' | 'PRE_PROMPT_UPDATE_QUIET_PERIOD_MS'
    | 'PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS' | 'LATE_FLUSH_INTERVAL_MS' | 'LATE_FLUSH_QUIET_PERIOD_MS'
    | 'LATE_FLUSH_WINDOW_MS',
    number
>;

const statics = AcpSdkBackend as unknown as BackendStatics;
const savedStatics = { ...statics };

beforeEach(() => {
    statics.UPDATE_QUIET_PERIOD_MS = 5;
    statics.UPDATE_DRAIN_TIMEOUT_MS = 50;
    statics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 1;
    statics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 50;
    statics.LATE_FLUSH_INTERVAL_MS = 5;
    statics.LATE_FLUSH_QUIET_PERIOD_MS = 10;
    statics.LATE_FLUSH_WINDOW_MS = 50;
});

afterEach(() => {
    Object.assign(statics, {
        UPDATE_QUIET_PERIOD_MS: savedStatics.UPDATE_QUIET_PERIOD_MS,
        UPDATE_DRAIN_TIMEOUT_MS: savedStatics.UPDATE_DRAIN_TIMEOUT_MS,
        PRE_PROMPT_UPDATE_QUIET_PERIOD_MS: savedStatics.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
        PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS: savedStatics.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS,
        LATE_FLUSH_INTERVAL_MS: savedStatics.LATE_FLUSH_INTERVAL_MS,
        LATE_FLUSH_QUIET_PERIOD_MS: savedStatics.LATE_FLUSH_QUIET_PERIOD_MS,
        LATE_FLUSH_WINDOW_MS: savedStatics.LATE_FLUSH_WINDOW_MS
    });
});

const SESSION = 'session-1';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolCall(toolCallId: string, extra: Record<string, unknown> = {}): { method: string; params: unknown } {
    return {
        method: 'session/update',
        params: {
            sessionId: SESSION,
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                toolCallId,
                title: toolCallId.split(':')[0],
                kind: 'execute',
                status: 'pending',
                rawInput: { command: 'echo hi' },
                ...extra
            }
        }
    };
}

function toolUpdate(toolCallId: string, status: string, extra: Record<string, unknown> = {}): { method: string; params: unknown } {
    return {
        method: 'session/update',
        params: {
            sessionId: SESSION,
            update: {
                sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                toolCallId,
                status,
                ...(status === 'completed' ? { rawOutput: { output: 'ok' } } : {}),
                ...extra
            }
        }
    };
}

function childUpdate(childSessionId: string, update: Record<string, unknown>): { method: string; params: unknown } {
    return {
        method: 'opencode/session/child_update',
        params: { rootSessionId: SESSION, childSessionId, parentSessionId: SESSION, depth: 1, type: 'update', update }
    };
}

const QUESTION_SCHEMA = {
    type: 'object',
    properties: {
        choice: {
            type: 'string',
            title: 'Pick',
            description: 'Which one?',
            oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }]
        }
    }
};

function questionForm(toolCallId: string): Record<string, unknown> {
    return { sessionId: SESSION, mode: 'form', toolCallId, message: 'Which one?', requestedSchema: QUESTION_SCHEMA };
}

function makeBackend(options: Omit<ConstructorParameters<typeof AcpSdkBackend>[0], 'command'> = {}): {
    backend: AcpSdkBackend;
    internal: BackendInternal;
    /** Scripts the agent's side of each session/prompt in order. */
    scriptPrompts: (...scripts: Array<() => Promise<string> | string>) => void;
    notify: (notification: { method: string; params: unknown }) => void;
} {
    const backend = new AcpSdkBackend({ command: 'opencode', ...options });
    const internal = backend as unknown as BackendInternal;
    const scripts: Array<() => Promise<string> | string> = [];
    internal.transport = {
        sendRequest: async (method) => {
            if (method !== 'session/prompt') return null;
            const script = scripts.shift();
            return { stopReason: script ? await script() : 'end_turn' };
        },
        sendNotification: () => {},
        close: async () => {}
    };
    const notify = (notification: { method: string; params: unknown }) =>
        internal.handleNotification(notification.method, notification.params);
    return { backend, internal, notify, scriptPrompts: (...next) => scripts.push(...next) };
}

function memoryStore(initial: StoredToolCallLifetime[] = []): ToolCallLifetimeStore & { appends: number; saves: number } {
    const snapshots = new Map<string, StoredToolCallLifetime[]>([[SESSION, initial]]);
    const journals = new Map<string, StoredToolCallLifetime[]>();
    const store = {
        appends: 0,
        saves: 0,
        load: (acpSessionId: string) => [...(snapshots.get(acpSessionId) ?? []), ...(journals.get(acpSessionId) ?? [])],
        append: (acpSessionId: string, lifetime: StoredToolCallLifetime) => {
            store.appends += 1;
            journals.set(acpSessionId, [...(journals.get(acpSessionId) ?? []), lifetime]);
        },
        appendClose: (acpSessionId: string, lifetimeId: string) => {
            journals.set(acpSessionId, (journals.get(acpSessionId) ?? []).filter((entry) => entry.id !== lifetimeId));
        },
        save: (acpSessionId: string, lifetimes: StoredToolCallLifetime[]) => {
            store.saves += 1;
            snapshots.set(acpSessionId, lifetimes);
            journals.delete(acpSessionId);
        }
    };
    return store;
}

async function prompt(backend: AcpSdkBackend, messages: AgentMessage[]): Promise<void> {
    await backend.prompt(SESSION, [{ type: 'text', text: 'go' }], (message) => messages.push(message));
}

function toolIds(messages: AgentMessage[], type: 'tool_call' | 'tool_result'): string[] {
    return messages.flatMap((message) => (message.type === type ? [message.id] : []));
}

function makeAgentStateSession(): { session: ApiSessionClient; state: () => AgentState; answer: (response: unknown) => Promise<void> } {
    let state: AgentState = {} as AgentState;
    const handlers = new Map<string, (params: unknown) => unknown>();
    const session = {
        rpcHandlerManager: {
            registerHandler: (method: string, handler: (params: unknown) => unknown) => handlers.set(method, handler)
        },
        updateAgentState: (update: (current: AgentState) => AgentState) => {
            state = update(state);
        },
        getAgentStateSnapshot: () => state
    } as unknown as ApiSessionClient;
    return {
        session,
        state: () => state,
        answer: async (response) => {
            await handlers.get(RPC_METHODS.Permission)?.(response);
        }
    };
}

describe('AcpSdkBackend tool call lifetimes', () => {
    it('makes a reused question:0 answerable after an aborted one, keeping the old answer record', async () => {
        const { backend, internal, notify, scriptPrompts } = makeBackend({ flavor: 'opencode', elicitationForm: true });
        const { session, state, answer } = makeAgentStateSession();
        const permissions = new OpencodePermissionHandler(session, backend, () => 'default');

        let abortedForm: Promise<FormElicitationResponse> | null = null;
        let reusedForm: Promise<FormElicitationResponse> | null = null;
        const messages: AgentMessage[] = [];

        scriptPrompts(
            async () => {
                notify(toolCall('question:0', { kind: 'other', title: 'question' }));
                abortedForm = internal.handleElicitationRequest(questionForm('question:0'));
                await sleep(5);
                // The user presses Stop while the question waits.
                await backend.cancelPrompt(SESSION);
                await permissions.cancelAll('User aborted');
                return 'cancelled';
            },
            async () => {
                notify(toolCall('question:0', { kind: 'other', title: 'question' }));
                reusedForm = internal.handleElicitationRequest(questionForm('question:0'));
                await sleep(5);
                return 'end_turn';
            }
        );

        await prompt(backend, messages);
        await expect(abortedForm).resolves.toEqual({ action: 'cancel' });
        const firstPromptCalls = toolIds(messages, 'tool_call');
        await prompt(backend, messages);

        const [abortedId] = firstPromptCalls;
        const reusedId = toolIds(messages, 'tool_call').find((id) => !firstPromptCalls.includes(id));
        expect(abortedId).toMatch(/^question:0#/);
        expect(reusedId).toMatch(/^question:0#/);
        expect(reusedId).not.toBe(abortedId);

        // The new question is pending under its own id; the aborted one stays settled.
        expect(state().requests?.[reusedId!]).toMatchObject({ tool: expect.any(String), toolCallId: reusedId });
        expect(state().completedRequests?.[reusedId!]).toBeUndefined();
        expect(state().completedRequests?.[abortedId!]).toMatchObject({ status: 'canceled', decision: 'abort' });

        await answer({ id: reusedId, approved: true, answers: { 0: ['b'] } });
        await expect(reusedForm).resolves.toEqual({ action: 'accept', content: { choice: 'b' } });
        expect(state().completedRequests?.[reusedId!]).toMatchObject({ status: 'approved', answers: { 0: ['b'] } });
        expect(state().completedRequests?.[abortedId!]).toMatchObject({ status: 'canceled' });
    });

    it('makes a reused question:0 answerable after an answered one whose result never arrived', async () => {
        const { backend, internal, notify, scriptPrompts } = makeBackend({ flavor: 'opencode', elicitationForm: true });
        const { session, state, answer } = makeAgentStateSession();
        new OpencodePermissionHandler(session, backend, () => 'default');
        const messages: AgentMessage[] = [];
        let firstForm: Promise<FormElicitationResponse> | null = null;
        scriptPrompts(
            async () => {
                notify(toolCall('question:0', { kind: 'other', title: 'question' }));
                firstForm = internal.handleElicitationRequest(questionForm('question:0'));
                await sleep(5);
                const [pendingId] = Object.keys(state().requests ?? {});
                await answer({ id: pendingId, approved: true, answers: { 0: ['a'] } });
                // No terminal tool_call_update for this call.
                return 'end_turn';
            },
            async () => {
                notify(toolCall('question:0', { kind: 'other', title: 'question' }));
                void internal.handleElicitationRequest(questionForm('question:0'));
                await sleep(5);
                return 'end_turn';
            }
        );

        await prompt(backend, messages);
        await expect(firstForm).resolves.toEqual({ action: 'accept', content: { choice: 'a' } });
        await prompt(backend, messages);

        const calls = [...new Set(toolIds(messages, 'tool_call'))];
        expect(calls).toHaveLength(2);
        expect(state().completedRequests?.[calls[0]]).toMatchObject({ status: 'approved' });
        expect(state().requests?.[calls[1]]).toMatchObject({ toolCallId: calls[1] });
        expect(state().completedRequests?.[calls[1]]).toBeUndefined();
    });

    it('gives two shell:0 calls in different prompts two ids, each with its own result', async () => {
        const { backend, notify, scriptPrompts } = makeBackend();
        const first: AgentMessage[] = [];
        const second: AgentMessage[] = [];
        const turn = () => {
            notify(toolCall('shell:0'));
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        };
        scriptPrompts(turn, turn);

        await prompt(backend, first);
        await prompt(backend, second);

        const [firstCall] = toolIds(first, 'tool_call');
        const [secondCall] = toolIds(second, 'tool_call');
        expect(firstCall).toMatch(/^shell:0#/);
        expect(secondCall).toMatch(/^shell:0#/);
        expect(secondCall).not.toBe(firstCall);
        expect(toolIds(first, 'tool_result')).toEqual([firstCall]);
        expect(toolIds(second, 'tool_result')).toEqual([secondCall]);
    });

    it('gives a reused id inside one prompt (next model step) a new id', async () => {
        const { backend, notify, scriptPrompts } = makeBackend();
        const messages: AgentMessage[] = [];
        scriptPrompts(() => {
            notify(toolCall('shell:0'));
            notify(toolUpdate('shell:0', 'completed'));
            notify(toolCall('shell:0', { rawInput: { command: 'ls' } }));
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });

        await prompt(backend, messages);

        const calls = [...new Set(toolIds(messages, 'tool_call'))];
        expect(calls).toHaveLength(2);
        expect(toolIds(messages, 'tool_result')).toEqual(calls);
    });

    it('keeps a running call on one id when a user message starts a prompt before its result', async () => {
        const { backend, notify, scriptPrompts } = makeBackend();
        const first: AgentMessage[] = [];
        const second: AgentMessage[] = [];
        scriptPrompts(
            () => {
                notify(toolCall('shell:0', { status: 'in_progress' }));
                return 'end_turn';
            },
            () => {
                notify(toolUpdate('shell:0', 'completed'));
                return 'end_turn';
            }
        );

        await prompt(backend, first);
        await prompt(backend, second);

        const [call] = toolIds(first, 'tool_call');
        expect(toolIds(second, 'tool_result')).toEqual([call]);
        expect(toolIds(second, 'tool_call')).toEqual([]);
    });

    it('lands a duplicate result on the same id instead of a new card', async () => {
        const { backend, notify, scriptPrompts } = makeBackend();
        const messages: AgentMessage[] = [];
        scriptPrompts(() => {
            notify(toolCall('shell:0'));
            notify(toolUpdate('shell:0', 'completed'));
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });

        await prompt(backend, messages);

        const [call] = toolIds(messages, 'tool_call');
        expect(toolIds(messages, 'tool_result')).toEqual([call, call]);
    });

    it('joins a call to the result that arrived before it', async () => {
        const { backend, notify, scriptPrompts } = makeBackend();
        const messages: AgentMessage[] = [];
        scriptPrompts(() => {
            notify(toolUpdate('read:1', 'completed'));
            notify(toolCall('read:1', { kind: 'read', title: 'read', rawInput: { filePath: '/tmp/a' } }));
            return 'end_turn';
        });

        await prompt(backend, messages);

        const [result] = toolIds(messages, 'tool_result');
        expect(result).toMatch(/^read:1#/);
        expect(new Set(toolIds(messages, 'tool_call'))).toEqual(new Set([result]));
    });

    it('keeps a child-session call on one id across parent prompts and a parent cancel', async () => {
        const { backend, notify, scriptPrompts } = makeBackend({ childSessionUpdates: true });
        const messages: AgentMessage[] = [];
        scriptPrompts(
            async () => {
                notify(childUpdate('ses_child', {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                    toolCallId: 'ses_child:shell:0',
                    title: 'shell',
                    kind: 'execute',
                    status: 'in_progress',
                    rawInput: { command: 'sleep 5' }
                }));
                await backend.cancelPrompt(SESSION);
                return 'cancelled';
            },
            () => {
                notify(childUpdate('ses_child', {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
                    toolCallId: 'ses_child:shell:0',
                    title: 'shell',
                    kind: 'execute',
                    status: 'in_progress',
                    rawInput: { command: 'sleep 5' }
                }));
                notify(childUpdate('ses_child', {
                    sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
                    toolCallId: 'ses_child:shell:0',
                    status: 'completed',
                    rawOutput: { output: 'done' }
                }));
                return 'end_turn';
            }
        );

        await prompt(backend, messages);
        await prompt(backend, messages);
        await sleep(30);

        const ids = new Set([...toolIds(messages, 'tool_call'), ...toolIds(messages, 'tool_result')]);
        expect(ids.size).toBe(1);
        expect([...ids][0]).toMatch(/^ses_child:shell:0#/);
    });

    it('asks permission under the lifetime id and answers the agent request it belongs to', async () => {
        const { backend, internal, notify, scriptPrompts } = makeBackend();
        const requests: PermissionRequest[] = [];
        backend.onPermissionRequest((request) => requests.push(request));
        const agentAnswers: Array<Promise<unknown>> = [];
        const messages: AgentMessage[] = [];
        const turn = async () => {
            notify(toolCall('shell:0'));
            agentAnswers.push(internal.handlePermissionRequest({
                sessionId: SESSION,
                toolCall: { toolCallId: 'shell:0', title: 'shell', rawInput: { command: 'rm x' } },
                options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
            }, null));
            await sleep(5);
            await backend.respondToPermission(SESSION, requests[requests.length - 1], { outcome: 'selected', optionId: 'once' });
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        };
        scriptPrompts(turn, turn);

        await prompt(backend, messages);
        await prompt(backend, messages);

        const calls = [...new Set(toolIds(messages, 'tool_call'))];
        expect(calls).toHaveLength(2);
        expect(requests.map((request) => request.id)).toEqual(calls);
        expect(requests.map((request) => request.toolCallId)).toEqual(calls);
        await expect(Promise.all(agentAnswers)).resolves.toEqual([
            { outcome: { outcome: 'selected', optionId: 'once' } },
            { outcome: { outcome: 'selected', optionId: 'once' } }
        ]);
    });

    it('keeps the id of a call in flight across a restart, without any pending request', async () => {
        const store = memoryStore();
        const before = makeBackend({ toolCallLifetimeStore: store });
        const first: AgentMessage[] = [];
        before.scriptPrompts(() => {
            before.notify(toolCall('shell:0', { status: 'in_progress' }));
            before.notify(toolCall('shell:1'));
            before.notify(toolUpdate('shell:1', 'completed'));
            return 'end_turn';
        });
        await prompt(before.backend, first);
        // The HAPI process dies without a clean exit.
        const [running, finished] = toolIds(first, 'tool_call');

        // A new HAPI process on the same ACP session (runner restart / resume).
        const after = makeBackend({ toolCallLifetimeStore: store });
        const second: AgentMessage[] = [];
        after.scriptPrompts(() => {
            after.notify(toolUpdate('shell:0', 'completed'));
            after.notify(toolCall('shell:1'));
            after.notify(toolCall('shell:0'));
            return 'end_turn';
        });
        await prompt(after.backend, second);

        expect(toolIds(second, 'tool_result')).toEqual([running]);
        const [freshFinishedId, freshRunningId] = toolIds(second, 'tool_call');
        expect(freshFinishedId).not.toBe(finished);
        expect(freshRunningId).not.toBe(running);
    });

    it('keeps the id of a call opened just before a crash, with no flush', async () => {
        const store = memoryStore();
        const before = makeBackend({ toolCallLifetimeStore: store });
        const first: AgentMessage[] = [];
        let crashed = false;
        before.scriptPrompts(() => {
            before.notify(toolCall('shell:0', { status: 'in_progress' }));
            return 'end_turn';
        });
        await prompt(before.backend, first);
        // The process dies here: no disconnect, no timer runs.
        crashed = true;
        const [running] = toolIds(first, 'tool_call');

        const after = makeBackend({ toolCallLifetimeStore: store });
        const second: AgentMessage[] = [];
        after.scriptPrompts(() => {
            after.notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });
        await prompt(after.backend, second);

        expect(crashed).toBe(true);
        expect(toolIds(second, 'tool_result')).toEqual([running]);
    });

    it('restores the in-flight call, not a finished one with the same id, after a crash before compaction', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-lifetimes-'));
        try {
            const store = createFileToolCallLifetimeStore(dir, 'hapi');
            const before = makeBackend({ toolCallLifetimeStore: store });
            const first: AgentMessage[] = [];
            before.scriptPrompts(() => {
                before.notify(toolCall('shell:0'));
                before.notify(toolUpdate('shell:0', 'completed'));
                before.notify(toolCall('shell:0', { status: 'in_progress', rawInput: { command: 'sleep 9' } }));
                return 'end_turn';
            });
            await prompt(before.backend, first);
            // Crash inside the compaction delay: only the journal holds this.
            const [finished, running] = [...new Set(toolIds(first, 'tool_call'))];

            const after = makeBackend({ toolCallLifetimeStore: createFileToolCallLifetimeStore(dir, 'hapi') });
            const second: AgentMessage[] = [];
            after.scriptPrompts(() => {
                after.notify(toolUpdate('shell:0', 'completed'));
                return 'end_turn';
            });
            await prompt(after.backend, second);

            expect(toolIds(second, 'tool_result')).toEqual([running]);
            expect(running).not.toBe(finished);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes an opened call as one journal record, not the whole set', async () => {
        const store = memoryStore();
        const { backend, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        let duringBurst = { appends: -1, saves: -1 };
        scriptPrompts(() => {
            for (let i = 0; i < 500; i += 1) notify(toolCall(`shell:${i}`, { status: 'in_progress' }));
            duringBurst = { appends: store.appends, saves: store.saves };
            return 'end_turn';
        });
        await prompt(backend, []);

        expect(duringBurst).toEqual({ appends: 500, saves: 0 });
        // The debounced compaction folds the journal into one snapshot.
        await sleep(250);
        expect(store.saves).toBe(1);
        expect(store.load(SESSION)).toHaveLength(500);
    });

    it('removes the session record only after the agent process tree is confirmed gone', async () => {
        const store = memoryStore();
        const { backend, internal, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        let confirmKill!: (ended: boolean) => void;
        internal.transport!.close = () => new Promise<boolean>((resolve) => { confirmKill = resolve; }) as Promise<never>;
        scriptPrompts(() => {
            notify(toolCall('shell:0', { status: 'in_progress' }));
            return 'end_turn';
        });
        await prompt(backend, []);

        const disconnected = backend.disconnect();
        await sleep(10);
        // Delete intent, kill not confirmed yet: a crash here keeps the record.
        expect(store.load(SESSION)).toHaveLength(1);
        confirmKill(true);
        await disconnected;
        expect(store.load(SESSION)).toEqual([]);
    });

    it('keeps the record when killing the agent process tree fails', async () => {
        const store = memoryStore();
        const { backend, internal, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        internal.transport!.close = async () => false as never;
        scriptPrompts(() => {
            notify(toolCall('shell:0', { status: 'in_progress' }));
            return 'end_turn';
        });
        await prompt(backend, []);
        await backend.disconnect();

        expect(store.load(SESSION).map((entry) => entry.agentToolCallId)).toEqual(['shell:0']);
    });

    it('keeps the record when the process dies before the kill is confirmed', async () => {
        const store = memoryStore();
        const { backend, internal, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        internal.transport!.close = async () => { throw new Error('killed by the runner'); };
        scriptPrompts(() => {
            notify(toolCall('shell:0', { status: 'in_progress' }));
            return 'end_turn';
        });
        await prompt(backend, []);
        await backend.disconnect().catch(() => {});

        expect(store.load(SESSION).map((entry) => entry.agentToolCallId)).toEqual(['shell:0']);
    });

    it('settles a question left pending by the previous process and shows its re-ask on the same card', async () => {
        const store = memoryStore();
        const before = makeBackend({ flavor: 'opencode', elicitationForm: true, toolCallLifetimeStore: store });
        const stored = makeAgentStateSession();
        new OpencodePermissionHandler(stored.session, before.backend, () => 'default');
        const first: AgentMessage[] = [];
        before.scriptPrompts(async () => {
            before.notify(toolCall('question:0', { kind: 'other', title: 'question' }));
            void before.internal.handleElicitationRequest(questionForm('question:0'));
            await sleep(5);
            return 'end_turn';
        });
        await prompt(before.backend, first);
        // The HAPI process dies without a clean exit.
        const [card] = toolIds(first, 'tool_call');
        expect(Object.keys(stored.state().requests ?? {})).toEqual([card]);

        // Restart: a new backend and writer bind to the stored session state.
        const after = makeBackend({ flavor: 'opencode', elicitationForm: true, toolCallLifetimeStore: store });
        new OpencodePermissionHandler(stored.session, after.backend, () => 'default');
        // No live buttons for a request nobody can answer any more.
        expect(stored.state().requests).toEqual({});
        expect(stored.state().completedRequests?.[card]).toMatchObject({ status: 'canceled', toolCallId: card });

        let reAsked: Promise<FormElicitationResponse> | null = null;
        after.scriptPrompts(async () => {
            reAsked = after.internal.handleElicitationRequest(questionForm('question:0'));
            await sleep(5);
            return 'end_turn';
        });
        await prompt(after.backend, []);

        const [pendingId] = Object.keys(stored.state().requests ?? {});
        expect(pendingId).toMatch(new RegExp(`^${card}~`));
        expect(stored.state().requests?.[pendingId]).toMatchObject({ toolCallId: card });
        expect(stored.state().completedRequests?.[pendingId]).toBeUndefined();
        await stored.answer({ id: pendingId, approved: true, answers: { 0: ['b'] } });
        await expect(reAsked).resolves.toEqual({ action: 'accept', content: { choice: 'b' } });
    });

    it('does not let the session/load replay before the first prompt displace a restored lifetime', async () => {
        const store = memoryStore([{ agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#STORED' }]);
        const { backend, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        const messages: AgentMessage[] = [];
        // session/load replays earlier shell:0 calls (dropped from display).
        notify(toolCall('shell:0'));
        notify(toolUpdate('shell:0', 'completed'));
        scriptPrompts(() => {
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });
        await prompt(backend, messages);

        expect(toolIds(messages, 'tool_result')).toEqual(['shell:0#STORED']);
    });

    it('keeps a parent call and a child call with the same agent id apart', async () => {
        const { backend, notify, scriptPrompts } = makeBackend({ childSessionUpdates: true });
        const messages: AgentMessage[] = [];
        const childStart = childUpdate('ses_child', {
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall, toolCallId: 'shell:0', title: 'shell', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' }
        });
        const childDone = childUpdate('ses_child', {
            sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate, toolCallId: 'shell:0', status: 'completed', rawOutput: { output: 'child' }
        });
        scriptPrompts(() => {
            notify(toolCall('shell:0', { status: 'in_progress' }));
            notify(childStart);
            notify(childDone);
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });
        await prompt(backend, messages);
        await sleep(30);

        const calls = [...new Set(toolIds(messages, 'tool_call'))];
        expect(calls).toHaveLength(2);
        expect(new Set(toolIds(messages, 'tool_result'))).toEqual(new Set(calls));
    });

    it('puts a second permission of the same call, in a later prompt, on that call\'s card', async () => {
        const { backend, internal, notify, scriptPrompts } = makeBackend();
        const requests: PermissionRequest[] = [];
        backend.onPermissionRequest((request) => {
            requests.push(request);
            void backend.respondToPermission(SESSION, request, { outcome: 'selected', optionId: 'once' });
        });
        const ask = () => internal.handlePermissionRequest({
            sessionId: SESSION,
            toolCall: { toolCallId: 'edit:1', title: 'edit' },
            options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }]
        }, null);
        const messages: AgentMessage[] = [];
        scriptPrompts(async () => {
            notify(toolCall('edit:1', { status: 'in_progress' }));
            await ask();
            return 'end_turn';
        }, async () => {
            // A user message arrived; the same call asks again.
            await ask();
            return 'end_turn';
        });
        await prompt(backend, messages);
        await prompt(backend, messages);

        const [card] = toolIds(messages, 'tool_call');
        expect(requests.map((request) => request.toolCallId)).toEqual([card, card]);
        expect(requests[0].id).toBe(card);
        expect(requests[1].id).not.toBe(card);
    });

    it('starts lifetimes afresh when the connection switches to another ACP session', async () => {
        const { backend, internal, scriptPrompts } = makeBackend();
        const messages: AgentMessage[] = [];
        const notifyIn = (sessionId: string, update: Record<string, unknown>) =>
            internal.handleNotification('session/update', { sessionId, update });
        scriptPrompts(
            () => {
                notifyIn(SESSION, { sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall, toolCallId: 'shell:0', title: 'shell', kind: 'execute', status: 'in_progress', rawInput: { command: 'sleep 9' } });
                return 'end_turn';
            },
            () => {
                notifyIn('session-2', { sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall, toolCallId: 'shell:0', title: 'shell', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } });
                return 'end_turn';
            }
        );

        await prompt(backend, messages);
        await backend.prompt('session-2', [{ type: 'text', text: 'go' }], (message) => messages.push(message));

        expect(new Set(toolIds(messages, 'tool_call')).size).toBe(2);
    });

    it('does not map history replayed while updates are suppressed', async () => {
        const store = memoryStore([{ agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#STORED' }]);
        const { backend, notify, scriptPrompts } = makeBackend({ toolCallLifetimeStore: store });
        const messages: AgentMessage[] = [];
        scriptPrompts(() => 'end_turn', () => {
            notify(toolUpdate('shell:0', 'completed'));
            return 'end_turn';
        });
        await prompt(backend, []);
        // e.g. OpenCode reloading the session after a rewind.
        await backend.suppressUpdatesDuring(async () => {
            notify(toolCall('shell:0'));
            notify(toolUpdate('shell:0', 'completed'));
        });
        await prompt(backend, messages);

        expect(toolIds(messages, 'tool_result')).toEqual(['shell:0#STORED']);
    });
});
