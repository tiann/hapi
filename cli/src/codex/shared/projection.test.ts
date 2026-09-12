import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';

describe('shared history projection', () => {
    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
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
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
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
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String));
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String));
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });
});
