import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import type { OpencodeSession } from './session';
import type { OpencodeHookEvent } from './types';
import type { OpencodeHookServer } from './utils/startOpencodeHookServer';

const native = vi.hoisted(() => ({ wait: Promise.resolve(), launched: vi.fn() }));
vi.mock('./opencodeLocal', () => ({ opencodeLocal: async () => { native.launched(); await native.wait; } }));
vi.mock('./utils/hookPlugin', () => ({ ensureOpencodeHookPlugin: vi.fn() }));
vi.mock('./utils/opencodeConfig', () => ({ ensureOpencodeConfig: () => ({ configPath: '/tmp/opencode-fixture.json' }) }));
vi.mock('./utils/config', () => ({ buildOpencodeEnv: () => ({}) }));
vi.mock('./utils/systemPrompt', () => ({ getTitleInstruction: () => 'fixture' }));
vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({ buildHapiMcpBridge: async () => ({
    server: { url: 'http://fixture', stop: vi.fn() }, mcpServers: { hapi: {} }
}) }));
vi.mock('./utils/opencodeStorageScanner', () => ({ createOpencodeStorageScanner: async () => ({
    cleanup: async () => {}, onNewSession: vi.fn()
}) }));

import { opencodeLocalLauncher } from './opencodeLocalLauncher';
import { OpencodeConversationHistory } from './conversationHistory';

describe('local canonical tool updates through the publication journal', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it.each(['completed', 'failed'] as const)(
        'reconciles separate v1 compaction identities after a local %s handoff', async (status) => {
            let releaseNative!: () => void;
            native.wait = new Promise<void>((resolve) => { releaseNative = resolve; });
            let handler: ((event: OpencodeHookEvent) => void) | undefined;
            let metadata: Metadata = { path: '/tmp/project', host: 'fixture', opencodeHistoryCheckpoint: {
                sessionId: 'native', messageIds: ['original'], userMessageIds: ['original'], localMessageIds: []
            } };
            const published: Array<{ message: unknown; localId?: string }> = [];
            const entries = [
                { info: { id: 'original', sessionID: 'native', role: 'user' } },
                { info: { id: 'marker', sessionID: 'native', role: 'user' } },
                { info: { id: 'summary', sessionID: 'native', role: 'assistant', parentID: 'marker', summary: true,
                    ...(status === 'completed' ? { finish: 'stop' } : { error: { message: 'interrupted' } }) } },
                ...(status === 'completed' ? [{ info: { id: 'continuation', sessionID: 'native', role: 'user' } }] : [])
            ];
            const session = {
                path: '/tmp/project', sessionId: 'native', startedBy: 'terminal', startingMode: 'local',
                client: { sessionId: 'hub-fixture', rpcHandlerManager: { registerHandler: vi.fn() },
                    updateMetadata(update: (current: Metadata) => Metadata) { metadata = update(metadata); },
                    materialize: async () => true, flushMetadata: async () => true, flush: async () => true,
                    sendAgentMessage(message: unknown, localId?: string) {
                        expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBe(true);
                        expect(metadata.opencodeHistoryCheckpoint?.localMessageIds).toEqual(expect.arrayContaining(['marker', 'summary']));
                        published.push({ message, localId });
                    } },
                queue: { size: () => 0, reset: vi.fn(), setOnMessage: vi.fn() },
                addHookEventHandler(callback: typeof handler) { handler = callback; },
                removeHookEventHandler: vi.fn(), onSessionFound: vi.fn(),
                sendUserMessage: vi.fn(), sendAgentMessage: vi.fn(),
                sendSessionEvent: vi.fn(), recordLocalLaunchFailure: vi.fn()
            };
            const result = opencodeLocalLauncher(session as unknown as OpencodeSession, {
                hookUrl: 'http://fixture/hook', hookServer: { token: 'fixture' } as unknown as OpencodeHookServer
            });
            try {
                await vi.waitFor(() => expect(native.launched).toHaveBeenCalledOnce());
                const event = (type: string, payload: unknown) => handler!({ event: type, sessionId: 'native', payload } as OpencodeHookEvent);
                // Summary metadata can arrive before its parent marker.
                event('message.updated', entries[2]);
                event('message.updated', entries[1]);
                event('message.part.updated', { part: { id: 'marker-part', sessionID: 'native', messageID: 'marker', type: 'compaction', auto: true } });
                if (status === 'completed') {
                    event('message.part.updated', { part: { id: 'summary-part', sessionID: 'native', messageID: 'summary', type: 'text', text: 'Native summary' } });
                    event('message.updated', entries[3]);
                    event('message.part.updated', { part: { id: 'continue-part', sessionID: 'native', messageID: 'continuation',
                        type: 'text', text: 'Continue', synthetic: true, metadata: { compaction_continue: true } } });
                }
                event('transcript.scan.completed', {});
                releaseNative();
                expect(await result).toBe('exit');
                expect(published).toEqual([{ message: status === 'completed'
                    ? { type: 'compact-summary', summary: 'Native summary' }
                    : { type: 'error', message: 'OpenCode compaction failed or was interrupted.' },
                    localId: `opencode:native:compaction:marker${status === 'failed' ? ':failed' : ''}` }]);
                expect(session.sendUserMessage).not.toHaveBeenCalled();
                expect(metadata.opencodeHistoryCheckpoint?.localMessageIds?.slice().sort()).toEqual(
                    status === 'completed' ? ['continuation', 'marker', 'summary'] : ['marker', 'summary']);
                expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBeUndefined();
                const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native' }),
                    async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { id: 'child' } : entries)));
                history.restoreCheckpoint(metadata.opencodeHistoryCheckpoint);
                history.rememberPromptIndex('local-original', 0);
                await expect(history.reconcileHistory()).resolves.toBe(status === 'completed' ? 3 : 2);
                await expect(history.fork()).resolves.toEqual({ nativeSessionId: 'child' });
                await expect(history.fork('local-original')).resolves.toEqual({ nativeSessionId: 'child' });
                // Native messages not witnessed through projection must still fail closed.
                entries.push({ info: { id: 'unobserved-user', sessionID: 'native', role: 'user' } });
                await expect(history.reconcileHistory()).rejects.toThrow('history diverged');
            } finally {
                releaseNative();
                await result;
            }
        }
    );

    it.each(['user', 'assistant', 'summary', 'failure'] as const)(
        'journals projected native %s output before forwarding it', async (kind) => {
            let releaseNative!: () => void;
            let releaseGuard!: () => void;
            native.wait = new Promise<void>((resolve) => { releaseNative = resolve; });
            const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
            let handler: ((event: OpencodeHookEvent) => void) | undefined;
            let metadata: Metadata = { path: '/tmp/project', host: 'fixture', opencodeHistoryCheckpoint: {
                sessionId: 'native', messageIds: [], userMessageIds: [], localMessageIds: []
            } };
            const messages: unknown[] = [];
            const send = (message: unknown) => {
                expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBe(true);
                messages.push(message);
            };
            const flushMetadata = vi.fn(async () => { await guard; return true; });
            const session = {
                path: '/tmp/project', sessionId: 'native', startedBy: 'terminal', startingMode: 'local',
                client: { sessionId: 'hub-fixture', rpcHandlerManager: { registerHandler: vi.fn() },
                    updateMetadata(update: (current: Metadata) => Metadata) { metadata = update(metadata); },
                    materialize: async () => true, flushMetadata, flush: async () => true, sendAgentMessage: send },
                queue: { size: () => 0, reset: vi.fn(), setOnMessage: vi.fn() },
                addHookEventHandler(callback: typeof handler) { handler = callback; },
                removeHookEventHandler: vi.fn(), onSessionFound: vi.fn(),
                sendUserMessage: send, sendAgentMessage: send,
                sendSessionEvent: vi.fn(), recordLocalLaunchFailure: vi.fn()
            };
            const result = opencodeLocalLauncher(session as unknown as OpencodeSession, {
                hookUrl: 'http://fixture/hook', hookServer: { token: 'fixture' } as unknown as OpencodeHookServer
            });
            try {
                await vi.waitFor(() => expect(native.launched).toHaveBeenCalledOnce());
                const event = (type: string, payload: unknown) => handler!({ event: type, sessionId: 'native', payload } as OpencodeHookEvent);
                if (kind === 'user' || kind === 'assistant') {
                    event('message.updated', { info: { sessionID: 'native', id: 'native-message', role: kind } });
                    event('message.part.updated', { part: { sessionID: 'native', id: 'text-part', messageID: 'native-message',
                        type: 'text', text: 'Native text', time: { end: 1 } } });
                } else {
                    event('message.updated', { info: { sessionID: 'native', id: 'native-message', type: 'compaction',
                        reason: 'auto', status: kind === 'summary' ? 'completed' : 'failed', summary: 'Native summary' } });
                    event('transcript.scan.completed', {});
                }
                await vi.waitFor(() => expect(flushMetadata).toHaveBeenCalled());
                expect(messages).toEqual([]);
                releaseGuard(); releaseNative();
                expect(await result).toBe('exit');
                expect(messages).toHaveLength(1);
                if (kind === 'summary') expect(messages[0]).toMatchObject({ type: 'compact-summary', summary: 'Native summary' });
                if (kind === 'failure') expect(messages[0]).toMatchObject({ type: 'error' });
                expect(metadata.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['native-message']);
                expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBeUndefined();
            } finally {
                releaseGuard(); releaseNative();
                await result;
            }
        }
    );

    it.each(['message.part.updated', 'tool.execute'] as const)(
        'retains partial-to-full tool input and its result behind the metadata ACK (%s)', async (transport) => {
            let releaseNative!: () => void;
            let releaseGuard!: () => void;
            native.wait = new Promise<void>((resolve) => { releaseNative = resolve; });
            const guard = new Promise<void>((resolve) => { releaseGuard = resolve; });
            let handler: ((event: OpencodeHookEvent) => void) | undefined;
            let metadata: Metadata = { path: '/tmp/project', host: 'fixture', opencodeHistoryCheckpoint: {
                sessionId: 'native', messageIds: [], userMessageIds: [], localMessageIds: []
            } };
            const messages: Array<Record<string, unknown>> = [];
            const flushMetadata = vi.fn(async () => { await guard; return true; });
            const session = {
                path: '/tmp/project', sessionId: 'native', startedBy: 'terminal', startingMode: 'local',
                client: {
                    sessionId: 'hub-fixture',
                    rpcHandlerManager: { registerHandler: vi.fn() },
                    updateMetadata(update: (current: Metadata) => Metadata) { metadata = update(metadata); },
                    materialize: async () => true, flushMetadata, flush: async () => true
                },
                queue: { size: () => 0, reset: vi.fn(), setOnMessage: vi.fn() },
                addHookEventHandler(callback: typeof handler) { handler = callback; },
                removeHookEventHandler: vi.fn(), onSessionFound: vi.fn(),
                sendAgentMessage(message: Record<string, unknown>) {
                    expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBe(true);
                    messages.push(message);
                },
                sendSessionEvent: vi.fn(), recordLocalLaunchFailure: vi.fn()
            };
            const result = opencodeLocalLauncher(session as unknown as OpencodeSession, {
                hookUrl: 'http://fixture/hook', hookServer: { token: 'fixture' } as unknown as OpencodeHookServer
            });
            try {
                await vi.waitFor(() => expect(native.launched).toHaveBeenCalledOnce());
                const emit = (input: Record<string, unknown>, completed = false) => {
                    const event = transport === 'message.part.updated' ? {
                        event: 'message.part.updated', sessionId: 'native', payload: { part: {
                            id: 'part-1', messageID: 'msg-1', type: 'tool', tool: 'write', callID: 'call-1',
                            state: { status: completed ? 'completed' : 'running', input, ...(completed ? { output: 'wrote' } : {}) }
                        } }
                    } : {
                        event: completed ? 'tool.execute.after' : 'tool.execute.before', sessionId: 'native',
                        payload: { messageID: 'msg-1', tool: { name: 'write', id: 'call-1', input }, ...(completed ? { output: 'wrote' } : {}) }
                    };
                    handler!(event as OpencodeHookEvent);
                };
                emit({ filePath: '/tmp/a.txt', content: '' });
                await vi.waitFor(() => expect(flushMetadata).toHaveBeenCalled());
                emit({ filePath: '/tmp/a.txt', content: 'final\n' }, true);
                expect(messages).toEqual([]);
                releaseGuard();
                releaseNative();
                expect(await result).toBe('exit');
                expect(messages).toHaveLength(3);
                expect(messages.map((message) => message.type)).toEqual(['tool-call', 'tool-call', 'tool-call-result']);
                expect(messages[0]).toMatchObject({ name: 'Write', callId: 'call-1', input: { content: '' } });
                expect(messages[1]).toMatchObject({ name: 'Write', callId: 'call-1', input: { content: 'final\n' } });
                expect(metadata.conversationHistoryDiverged).not.toBe(true);
                expect(metadata.opencodeHistoryCheckpoint?.localMessageIds).toEqual(['msg-1']);
                expect(metadata.opencodeHistoryCheckpoint?.localPublicationPending).toBeUndefined();
            } finally {
                releaseGuard(); releaseNative();
                await result;
            }
        }
    );
});
