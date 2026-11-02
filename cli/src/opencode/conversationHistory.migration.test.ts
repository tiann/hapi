import { describe, expect, it, vi } from 'vitest';
import { MetadataSchema } from '@hapi/protocol/schemas';
import { OpencodeConversationHistory } from './conversationHistory';
import { observeLocalHistory } from './localHistory';

const legacy: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [
    { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'one' }] },
    { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'answer' },
        { type: 'tool', callID: 'call-one', tool: 'read', state: { status: 'completed', input: {}, output: 'tool context' } }] },
    { info: { id: 'marker', role: 'user' }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'summary', role: 'assistant', summary: true, parentID: 'marker', time: { completed: 1 } },
        parts: [{ type: 'text', text: 'exact summary' }] },
    { info: { id: 'continuation', role: 'user' }, parts: [{ type: 'text', text: 'continue', synthetic: true }] },
    { info: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'two' }] },
    { info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'second answer' }] }
];
const projected = [
    { id: 'u1', type: 'user', text: 'one' },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'answer' },
        { type: 'tool', id: 'call-one', name: 'read', state: {
            status: 'completed', input: {}, content: [{ type: 'text', text: 'tool context' }], metadata: {}
        } }] },
    { id: 'marker', type: 'compaction', status: 'completed', reason: 'manual', summary: 'exact summary' },
    { id: 'continuation', type: 'synthetic', text: 'continue' },
    { id: 'u2', type: 'user', text: 'two' },
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: 'second answer' }] }
];

async function originalCheckpoint(rows = legacy) {
    const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v1' }),
        async () => Response.json(rows));
    await history.reconcileHistory(undefined, { allowUnobservedAppend: true });
    return structuredClone(history.getCheckpoint()!);
}

describe('OpenCode identity-proven v1 projection migration', () => {
    it('preserves migration evidence through metadata validation', async () => {
        const checkpoint = await originalCheckpoint();
        expect(checkpoint.v1Migration).toBeDefined();
        const metadata = MetadataSchema.parse({ path: '/fixture', host: 'fixture', opencodeHistoryCheckpoint: checkpoint });
        expect(metadata.opencodeHistoryCheckpoint?.v1Migration).toEqual(checkpoint.v1Migration);
    });

    it('reconciles only the proven summary/synthetic transforms and reindexes by original user identity', async () => {
        const checkpoint = await originalCheckpoint();
        const transport = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
            ? Response.json({ data: { id: 'child' } }) : Response.json({ data: projected, cursor: {} }));
        const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v2' }), transport);
        history.restoreCheckpoint(checkpoint);
        history.restorePromptIndexes({ 'local-one': 0, 'local-two': 3 });
        await expect(history.reconcileHistory()).resolves.toBe(2);
        expect(history.getHistoryIndexes()).toEqual({ 'local-one': 0, 'local-two': 1 });
        expect(history.getCheckpoint()?.v1Migration).toBeUndefined();
        await expect(history.fork('local-two')).resolves.toEqual({ nativeSessionId: 'child' });
        const post = transport.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(post![1]!.body as string)).toEqual({ before: 'u2' });
        expect(history.isDiverged()).toBe(false);
    });

    it.each(['summary-text', 'tool-output', 'missing-assistant', 'extra-user', 'wrong-synthetic-text', 'missing-proof', 'pending-publication', 'missing-local-journal', 'different-session', 'invalid-locator'])(
        'retains the divergence fence for %s', async (mutation) => {
            const checkpoint = await originalCheckpoint();
            let rows: Array<Record<string, unknown>> = structuredClone(projected);
            if (mutation === 'summary-text') rows = rows.map(row => row.id === 'marker' ? { ...row, summary: 'changed' } : row);
            if (mutation === 'tool-output') rows = rows.map(row => row.id === 'a1' ? { ...row, content: [{ type: 'text', text: 'tool context removed' }] } : row);
            if (mutation === 'missing-assistant') rows = rows.filter(row => row.id !== 'a1');
            if (mutation === 'extra-user') rows.splice(2, 0, { id: 'foreign', type: 'user', text: 'unobserved' });
            if (mutation === 'wrong-synthetic-text') rows = rows.map(row => row.id === 'continuation' ? { ...row, text: 'changed' } : row);
            if (mutation === 'missing-proof') delete checkpoint.v1Migration;
            if (mutation === 'pending-publication') checkpoint.localPublicationPending = true;
            if (mutation === 'missing-local-journal') delete checkpoint.localMessageIds;
            if (mutation === 'different-session') checkpoint.sessionId = 'different';
            const transport = vi.fn(async () => Response.json({ data: rows, cursor: {} }));
            const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v2' }), transport);
            history.restoreCheckpoint(checkpoint);
            history.restorePromptIndexes({ 'local-two': mutation === 'invalid-locator' ? 1 : 3 });
            await expect(history.reconcileHistory()).rejects.toThrow('history diverged');
            expect(history.isDiverged()).toBe(true);
            expect(history.getHistoryPoints()).toEqual({});
            expect(transport.mock.calls).toHaveLength(1);
        }
    );

    it.each(['mixed-synthetic', 'attachment', 'subtask', 'running-tool', 'compacted-tool', 'summary-tool', 'summary-reasoning', 'unfinished-summary', 'retained-tail'])(
        'does not manufacture migration evidence for unsupported v1 %s', async (shape) => {
        const rows = structuredClone(legacy);
        if (shape === 'mixed-synthetic') rows[0]!.parts.push({ type: 'text', text: 'hidden', synthetic: true });
        if (shape === 'attachment') rows[0]!.parts.push({ type: 'file', url: 'data:text/plain;base64,YQ==', mime: 'text/plain' });
        if (shape === 'subtask') rows[0]!.parts.push({ type: 'subtask', prompt: 'nested' });
        if (shape === 'running-tool') rows[1]!.parts[1]!.state = { status: 'running', input: {} };
        if (shape === 'compacted-tool') (rows[1]!.parts[1]!.state as Record<string, unknown>).time = { compacted: 1 };
        if (shape === 'summary-tool') rows[3]!.parts.push(structuredClone(rows[1]!.parts[1]!));
        if (shape === 'summary-reasoning') rows[3]!.parts.push({ type: 'reasoning', text: 'hidden context' });
        if (shape === 'unfinished-summary') rows[3]!.info.time = {};
        if (shape === 'retained-tail') rows[2]!.parts[0]!.tail_start_id = 'u1';
        expect((await originalCheckpoint(rows)).v1Migration).toBeUndefined();
    });

    it('rejects semantic mutation even when migration leaves all message identities unchanged', async () => {
        const checkpoint = await originalCheckpoint(legacy.slice(0, 2));
        expect(checkpoint.v1Migration).toBeDefined();
        const rows = structuredClone(projected.slice(0, 2));
        rows[0]!.text = 'changed with the same ID';
        const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v2' }),
            async () => Response.json({ data: rows, cursor: {} }));
        history.restoreCheckpoint(checkpoint);
        history.restorePromptIndexes({ local: 0 });
        await expect(history.reconcileHistory()).rejects.toThrow('history diverged');
        expect(history.getHistoryPoints()).toEqual({});
    });

    it.each([true, false])('normalizes published summary identity but rejects unrelated missing publication (valid=%s)', async (valid) => {
        const checkpoint = await originalCheckpoint();
        const metadata = observeLocalHistory({ path: '/fixture', host: 'fixture', opencodeHistoryCheckpoint: checkpoint },
            'native', valid ? 'summary' : 'unproven');
        const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v2' }),
            async () => Response.json({ data: projected, cursor: {} }));
        history.restoreCheckpoint(metadata.opencodeHistoryCheckpoint);
        history.restorePromptIndexes({ local: 3 });
        if (valid) {
            await expect(history.reconcileHistory()).resolves.toBe(2);
            expect(history.getHistoryIndexes()).toEqual({ local: 1 });
        } else {
            await expect(history.reconcileHistory()).rejects.toThrow('history diverged');
        }
    });

    it('retains the native undo fence after successful normalization and blocks a fork write', async () => {
        let rows: Array<Record<string, unknown>> = structuredClone(projected);
        const transport = vi.fn(async () => Response.json({ data: rows, cursor: {} }));
        const history = new OpencodeConversationHistory(() => ({ baseUrl: 'http://fixture', sessionId: 'native', mode: 'v2' }), transport);
        history.restoreCheckpoint(await originalCheckpoint());
        history.restorePromptIndexes({ local: 3 });
        await history.reconcileHistory();
        rows = rows.slice(0, -2);
        await expect(history.fork('local')).rejects.toThrow('history diverged');
        expect(history.isDiverged()).toBe(true);
        expect(history.getHistoryPoints()).toEqual({});
        expect(transport.mock.calls).toHaveLength(2);
    });
});
