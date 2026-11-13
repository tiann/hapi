import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import type { OpencodeSession } from './session';
import type { OpencodeHookEvent } from './types';
import type { OpencodeHookServer } from './utils/startOpencodeHookServer';
import { OpenCodeRewind, OpenCodeRuntimeGate } from './rewind';
import { getProcessStartMarker } from '@/utils/process';
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    beforeEach(() => { vi.clearAllMocks(); native.wait = Promise.resolve(); });

    const operation: OpenCodeRewindOperation = { operationId: 'local-resume-op', nativeSessionId: 'native', workerId: 'worker',
        workerPid: process.pid, workerStartMarker: getProcessStartMarker(process.pid)!,
        requestedLocalId: 'two', nativeMessageId: 'u2', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 4,
        reservationVersion: 1, sourceTranscriptHash: 'a'.repeat(64), phase: 'reserved' };
    function localSession(metadata: Metadata, runtimeGate = new OpenCodeRuntimeGate()) {
        return { path: '/tmp/project', sessionId: 'native', startedBy: 'terminal', startingMode: 'local', runtimeGate,
            client: { sessionId: 'hub-local-admission', rpcHandlerManager: { registerHandler: vi.fn() },
                getMetadata: () => metadata, updateMetadata: (update: (value: Metadata) => Metadata) => { metadata = update(metadata); },
                materialize: async () => true, flushMetadata: async () => true, flush: async () => true },
            queue: { size: () => 0, reset: vi.fn(), setOnMessage: vi.fn() },
            addHookEventHandler: vi.fn(), removeHookEventHandler: vi.fn(), onSessionFound: vi.fn(),
            sendSessionEvent: vi.fn(), recordLocalLaunchFailure: vi.fn() } as unknown as OpencodeSession;
    }
    const localOptions = { hookUrl: 'http://fixture/hook', hookServer: { token: 'fixture' } as unknown as OpencodeHookServer };

    it.each(['reserved', 'prepared', 'unknown', 'committed', 'rejected'] as const)(
        'blocks terminal local native launch before settlement of %s, even with a fresh open JS gate', async (phase) => {
            const session = localSession({ path: '/tmp/project', host: 'fixture', opencodeRewind: { ...operation, phase } });
            await expect(opencodeLocalLauncher(session, localOptions)).rejects.toThrow('reconciliation');
            expect(native.launched).not.toHaveBeenCalled();
        });

    it.each([undefined] as const)('allows local native launch for the safe %s control', async (phase) => {
        const session = localSession({ path: '/tmp/project', host: 'fixture',
            ...(phase ? { opencodeRewind: { ...operation, phase } } : {}) });
        expect(await opencodeLocalLauncher(session, localOptions)).toBe('exit');
        expect(native.launched).toHaveBeenCalledOnce();
    });

    it('allows local launch only after this wrapper reconciles the exact rejected tombstone', async () => {
        const gate = new OpenCodeRuntimeGate();
        const rejected = { ...operation, phase: 'rejected' as const };
        const metadata: Metadata = { path: '/tmp/project', host: 'fixture', opencodeRewind: rejected };
        const controller = new OpenCodeRewind({ directory: mkdtempSync(join(tmpdir(), 'rewind-local-rejected-')),
            hapiSessionId: 'rejected-local', workerId: 'worker', gate, baseUrl: 'http://native', nativeSessionId: 'native', headers: {},
            request: async () => { throw new Error('native must not be queried'); },
            report: async () => { throw new Error('Hub rejection already confirmed'); },
            getAuthoritativeOperation: async () => metadata.opencodeRewind,
            flush: async () => true, isIdle: () => true, sourceCheckpoint: () => undefined,
            sourceIndexes: () => ({}), requestsFromPreviousWorkerCannotRun: () => false });
        expect(await controller.recover(rejected)).toMatchObject({ outcome: 'rejected' });
        expect(await opencodeLocalLauncher(localSession(metadata, gate), localOptions)).toBe('exit');
        expect(native.launched).toHaveBeenCalledOnce();
        metadata.opencodeRewind = { ...rejected, operationId: 'different-rejection' };
        await expect(opencodeLocalLauncher(localSession(metadata, gate), localOptions)).rejects.toThrow('reconciliation');
        expect(native.launched).toHaveBeenCalledOnce();
    });

    it('allows local ownership only after this wrapper finalized and consumed that committed operation', async () => {
        const gate = new OpenCodeRuntimeGate();
        let current = [{ id: 'u1', type: 'user', text: 'one' }, { id: 'u2', type: 'user', text: 'two' }];
        let staged: string | undefined;
        const metadata: Metadata = { path: '/tmp/project', host: 'fixture', opencodeRewind: operation };
        const controller = new OpenCodeRewind({ directory: mkdtempSync(join(tmpdir(), 'rewind-local-admission-')),
            hapiSessionId: 'local-finalized', workerId: 'worker', gate, baseUrl: 'http://native', nativeSessionId: 'native', headers: {},
            request: async (url) => {
                if (url.endsWith('/revert/stage')) { staged = 'u2'; return Response.json({}); }
                if (url.endsWith('/revert/commit')) { current = current.slice(0, 1); staged = undefined; return new Response(null, { status: 204 }); }
                if (url.includes('/message?')) return Response.json({ data: current, cursor: {} });
                if (url.endsWith('/active')) return Response.json({ data: {} });
                if (url.endsWith('/inbox')) return Response.json({ data: [] });
                return Response.json({ data: { id: 'native', ...(staged ? { revert: { messageID: staged } } : {}) } });
            }, report: async report => {
                const value = { ...operation, phase: report.phase === 'applied' ? 'committed' as const : report.phase };
                metadata.opencodeRewind = value; return value;
            }, getAuthoritativeOperation: async () => metadata.opencodeRewind, flush: async () => true, isIdle: () => true,
            sourceCheckpoint: () => ({ sessionId: 'native', messageIds: ['u1', 'u2'], userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
            sourceIndexes: () => ({ one: 0, two: 1 }), requestsFromPreviousWorkerCannotRun: () => false,
            consumeCommitted: async () => {} });
        expect(await controller.execute(operation)).toMatchObject({ success: true });
        expect(await opencodeLocalLauncher(localSession(metadata, gate), localOptions)).toBe('exit');
        expect(native.launched).toHaveBeenCalledOnce();
        metadata.opencodeRewind = { ...operation, operationId: 'different-committed-op', phase: 'committed' };
        await expect(opencodeLocalLauncher(localSession(metadata, gate), localOptions)).rejects.toThrow('reconciliation');
        expect(native.launched).toHaveBeenCalledOnce();
    });


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
                runtimeGate: new OpenCodeRuntimeGate(),
                client: { sessionId: 'hub-fixture', rpcHandlerManager: { registerHandler: vi.fn() },
                    getMetadata: () => metadata,
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
                runtimeGate: new OpenCodeRuntimeGate(),
                client: {
                    sessionId: 'hub-fixture',
                    getMetadata: () => metadata,
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
