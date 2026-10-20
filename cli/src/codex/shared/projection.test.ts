import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';
import { codexPlanProposalId } from './plan';
import { extractNotifySummary } from '@hapi/protocol/messages';

describe('shared history projection', () => {
    it('acknowledges child output after projecting its trace rows', async () => {
        const order: string[] = [];
        const session = { getMetadata: () => ({}),
            sendAgentMessage: vi.fn(() => { order.push('message'); }),
            emitMessagesConsumed: vi.fn(() => { order.push('ack'); }) } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', async () => {}, 'parent');
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [
            { id: 'reply', type: 'agentMessage', text: 'child reply' }
        ] }] });
        expect(session.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace' }),
            'codex:child:turn:reply:agent_message', { acknowledgeConsumption: false });
        expect(session.emitMessagesConsumed).toHaveBeenCalledWith(['codex:child:turn:reply:agent_message']);
        expect(order).toEqual(['message', 'ack']);
    });
    it('persists historical user IDs before replay and acknowledges only after inserting the transcript', async () => {
        const order: string[] = [];
        const session = { emitMessagesConsumed: vi.fn(() => { order.push('ack'); }), getMetadata: () => ({}), updateMetadata: vi.fn(),
            sendUserMessage: () => order.push('user'), sendAgentMessage: vi.fn() } as unknown as ApiSessionClient;
        const batch = vi.fn(async () => { order.push('batch'); });
        const projection = new SharedCodexProjection(session, 'thread', async () => { order.push('commit'); }, undefined, batch);
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [
            { id: 'native', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
            { id: 'remote', clientId: 'local', type: 'userMessage', content: [{ type: 'text', text: 'second' }] }
        ] }] });
        expect(batch).toHaveBeenCalledWith(['codex:thread:user:native', 'local']);
        expect(order[0]).toBe('batch');
        expect(order).toContain('user');
        expect(order).not.toContain('commit');
        expect(order.at(-1)).toBe('ack');
        expect(session.emitMessagesConsumed).toHaveBeenCalledWith(['codex:thread:user:native', 'local']);
    });
    it('replays known user history without rewriting its persisted turn mapping', async () => {
        let metadata = { conversationHistoryTurns: { local: 'turn' }, conversationHistoryPoints: { local: true } };
        const updateMetadata = vi.fn((handler: (value: typeof metadata) => typeof metadata) => { metadata = handler(metadata); });
        const committed = vi.fn(async () => {});
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => metadata, updateMetadata, sendUserMessage: vi.fn(), sendAgentMessage: vi.fn() } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', committed);
        const history = { turns: [{ id: 'turn', status: 'completed', items: [
            { id: 'user', clientId: 'local', type: 'userMessage', content: [{ type: 'text', text: 'existing prompt' }] }
        ] }] };
        await projection.history(history);
        projection.reset();
        await projection.history(history);
        expect(committed).toHaveBeenCalledWith('local');
        expect(session.sendUserMessage).toHaveBeenCalledWith('existing prompt', undefined, 'local', { acknowledgeConsumption: false });
        expect(updateMetadata).not.toHaveBeenCalled();
        await projection.notification('item/started', { threadId: 'thread', turnId: 'next', item: {
            id: 'new-user', clientId: 'new-local', type: 'userMessage', content: [{ type: 'text', text: 'new prompt' }]
        } });
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(metadata.conversationHistoryTurns).toMatchObject({ local: 'turn', 'new-local': 'next' });
        expect(metadata.conversationHistoryPoints).toMatchObject({ local: true, 'new-local': true });
    });
    it.each([undefined, 'root'])('publishes only final summaries in live output and history replay (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const footer = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Finished"}';
        const items = [
            { id: 'progress', type: 'agentMessage', phase: 'commentary', text: `Still working.\n${footer}` },
            { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: `More work.\n${footer}` },
            { id: 'footer-only', type: 'agentMessage', phase: 'commentary', text: footer },
            { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `Finished.\n${footer}` }
        ];
        for (const item of items) {
            await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        }
        const live = send.mock.calls.slice();
        const bodies = live.map(([body]) => parentThreadId ? body.message : body);
        expect(bodies.map(body => body.message)).toEqual(['Still working.', 'More work.', `Finished.\n${footer}`]);
        expect(bodies.filter(body => extractNotifySummary(body.message))).toHaveLength(1);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items }] });
        expect(send.mock.calls).toEqual(live);
    });

    it.each([undefined, 'root'])('persists proposals without approval and replays the same IDs (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'plan', type: 'plan', text: '# Final plan' };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', { ...params, item: { id: 'before', type: 'agentMessage', text: 'Preface' } });
        await projection.notification('item/started', params);
        await projection.notification('item/plan/delta', { ...params, itemId: 'plan', delta: '# Provisional' });
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', { ...params, item: { id: 'after', type: 'agentMessage', text: 'Postscript' } });
        expect(send).toHaveBeenCalledTimes(4);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        const callId = codexPlanProposalId('thread', 'turn', 'plan');
        expect(bodies).toEqual([
            expect.objectContaining({ type: 'message', message: 'Preface' }),
            expect.objectContaining({ type: 'tool-call', name: 'ExitPlanMode', callId, input: { plan: '# Final plan' } }),
            expect.objectContaining({ type: 'tool-call-result', callId, output: null }),
            expect.objectContaining({ type: 'message', message: 'Postscript' })
        ]);
        const original = send.mock.calls.slice(1, 3);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });

    it('waits for final proposal content after an active snapshot', async () => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'plan', type: 'plan', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'final' } });
        expect(send.mock.calls[0][0]).toMatchObject({ input: { plan: 'final' } });
        expect(send.mock.calls[1][0]).toMatchObject({ output: null });
    });

    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        for (const failed of [true, false]) {
            for (const type of ['mcpToolCall', 'collabAgentToolCall']) {
                const item = { id: `${type}-${failed}`, type, server: 'test', tool: 'spawnAgent',
                    status: failed ? 'failed' : 'completed', error: failed ? { message: 'failed' } : null,
                    result: { Ok: 'done' } };
                await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
                const body = send.mock.lastCall?.[0];
                const result = parentThreadId ? body.message : body;
                expect(result).toMatchObject({ type: 'tool-call-result', is_error: failed });
                expect(result).not.toHaveProperty('isError');
            }
        }
    });
    it('keeps each turn model through settings changes, reconnect replay and rerouting', async () => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-a');
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } }, 'model-b');
        projection.reset();
        // A replayed start must not rewrite the executing model either.
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-b');
        const usage = async (turnId: string) => projection.notification('thread/tokenUsage/updated', {
            threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } }
        }, 'model-b');
        await usage('old');
        await projection.notification('model/rerouted', { threadId: 'thread', turnId: 'new', fromModel: 'model-b', toModel: 'model-c', reason: 'test' });
        await usage('new');
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'token_count');
        expect(events.map(body => body.model)).toEqual(['model-a', 'model-c']);
    });
    it('keeps image-only native inputs visible without embedding data URLs', () => {
        expect(inputText([{ type: 'image', url: 'data:image/png;base64,large' }])).toBe('[Image]');
        expect(inputText([{ type: 'localImage', path: '/tmp/image.png' }])).toBe('[Image: /tmp/image.png]');
    });
    it('replays after hub reconnect using the same durable local id', async () => {
        const send = vi.fn(); const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String), { acknowledgeConsumption: false });
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String), { acknowledgeConsumption: false });
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });

    it('announces parent compaction start via session event, deduping repeats', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const params = { threadId: 'thread', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } };
        await projection.notification('item/started', params);
        await projection.notification('item/started', params);
        await projection.notification('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'c2', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent.mock.calls).toEqual([
            [{ type: 'message', message: '📦 Compaction started' }],
            [{ type: 'message', message: '📦 Compaction started' }]
        ]);
    });
    it('keeps child compaction start as trace with statusText, never a parent status', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        await projection.notification('item/started', { threadId: 'child', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
        const [body] = send.mock.calls[0];
        expect(body.type).toBe('agent-run-trace');
        expect(body.message.type).toBe('compaction_started');
        expect(body.message.statusText).toBe('📦 Compaction started');
    });
    it('emits live compaction start but not for completed history replay', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { emitMessagesConsumed: vi.fn(), getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'completed',
            items: [{ id: 'c1', type: 'contextCompaction' }] }] });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send.mock.calls.map(([b]) => b).some((b) => b.message === '📦 Compaction started')).toBe(false);
        expect(send.mock.calls.map(([b]) => b)).toContainEqual(expect.objectContaining({ type: 'context_compacted' }));
        send.mockClear();
        await projection.notification('item/started', { threadId: 'thread', turnId: 'live', item: { id: 'c9', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction started' });
    });
});
