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

describe('local canonical tool updates through the publication journal', () => {
    beforeEach(() => { vi.clearAllMocks(); });

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
