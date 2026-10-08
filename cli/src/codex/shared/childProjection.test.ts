import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection } from './projection';
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';

describe('native child card projection', () => {
    it('isolates identity and actual execution, recovers delayed context, preserves reasoning and replays history', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-projection-'));
        try {
            const send = vi.fn();
            const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
            const a = new SharedCodexProjection(session, 'child-a', async () => {}, 'root');
            const b = new SharedCodexProjection(session, 'child-b', async () => {}, 'root');
            const path = join(dir, 'rollout.jsonl');
            await writeFile(path, line('session_meta', { id: 'child-a' }));
            a.childThread({ id: 'child-a', path, model: 'next-request', reasoningEffort: 'max', agentNickname: 'Aristotle', agentRole: 'reviewer', source: { subAgent: { thread_spawn: { agent_path: '/root/task_a' } } } });
            b.childThread({ id: 'child-b', agentNickname: 'Plato', source: { subAgent: { thread_spawn: { agent_path: '/root/task_b' } } } });
            await a.notification('turn/started', { threadId: 'child-a', turn: { id: 't1', startedAt: 10 } }, 'parent-model');
            await a.notification('turn/completed', { threadId: 'child-a', turn: { id: 't1', status: 'completed', startedAt: 10 } });
            await appendFile(path, line('turn_context', { turn_id: 't1', model: 'applied-child', effort: 'low' }));
            await a.refreshEvidence();
            await a.notification('item/completed', { threadId: 'child-a', turnId: 't1', item: { id: 'reason', type: 'reasoning', summary: ['Retained reasoning'], content: [] } });
            const metadata = send.mock.calls.map(([body]) => body).filter(body => body.metadataOnly);
            expect(metadata).toContainEqual(expect.objectContaining({ agentId: 'child-a', input: { agentIdentity: { taskName: 'task_a', nickname: 'Aristotle', agentPath: '/root/task_a', role: 'reviewer' } } }));
            expect(metadata).toContainEqual(expect.objectContaining({ agentId: 'child-a', input: { agentExecution: { turnId: 't1', model: 'applied-child', reasoningEffort: 'low', source: 'codex-turn-context' } } }));
            expect(metadata.filter(body => body.agentId === 'child-b').some(body => body.input.agentExecution)).toBe(false);
            expect(send.mock.calls.some(([body]) => body.type === 'agent-run-trace' && body.message.type === 'reasoning')).toBe(true);
            for (const toModel of ['routed-a', 'routed-b', 'routed-a']) await a.notification('model/rerouted', { threadId: 'child-a', turnId: 't1', toModel });
            expect(send.mock.calls.map(([body]) => body).filter(body => body.input?.agentExecution?.source === 'codex-model-rerouted').map(body => body.input.agentExecution.model)).toEqual(['routed-a', 'routed-b', 'routed-a']);
            a.reset(); send.mockClear();
            await a.history({ id: 'child-a', path, model: 'future', reasoningEffort: 'high', turns: [{ id: 't1', status: 'completed', startedAt: 10, items: [] }] });
            expect(send.mock.calls[0][0]).toMatchObject({ status: 'completed', activityKind: 'turn_snapshot' });
            expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'routed-a')).toBe(true);
            await a.notification('turn/started', { threadId: 'child-a', turn: { id: 't2', startedAt: null } });
            await a.notification('turn/started', { threadId: 'child-a', turn: { id: 't1', startedAt: null } });
            await appendFile(path, line('turn_context', { turn_id: 't2', model: 'new-turn', effort: 'medium' }));
            await a.refreshEvidence();
            expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'new-turn')).toBe(true);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});

it('keeps the late-rollout retry window through parent event bursts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-child-burst-'));
    const now = vi.spyOn(Date, 'now'); let clock = 100_000; now.mockImplementation(() => clock);
    try {
        const path = join(dir, 'rollout.jsonl');
        await writeFile(path, line('session_meta', { id: 'child' }));
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const child = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        child.childThread({ id: 'child', path });
        await child.notification('turn/completed', { threadId: 'child', turn: { id: 't', status: 'completed' } });
        for (let i = 0; i < 30; i++) await child.refreshEvidence();
        await appendFile(path, line('turn_context', { turn_id: 't', model: 'after-flush', effort: 'medium' }));
        clock += 2_000; await child.refreshEvidence();
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'after-flush')).toBe(true);
        await child.notification('turn/started', { threadId: 'child', turn: { id: 't2' } });
        await child.notification('turn/started', { threadId: 'child', turn: { id: 't' } });
        await appendFile(path, line('turn_context', { turn_id: 't2', model: 'latest-after-stale-start', effort: 'high' }));
        await child.refreshEvidence();
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'latest-after-stale-start')).toBe(true);
    } finally { now.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

it('persists native completion timing and gives enriched snapshots a new stable delivery ID', async () => {
    const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
    const child = new SharedCodexProjection(session, 'child', async () => {}, 'root');
    await child.notification('turn/started', { threadId: 'child', turn: { id: 't', startedAt: 10 } });
    await child.notification('turn/completed', { threadId: 'child', turn: { id: 't', startedAt: 10, completedAt: 15, status: 'completed' } });
    expect(send.mock.calls[1][0]).toMatchObject({ startedAt: 10_000, completedAt: 15_000, status: 'completed' });
    const thread = (completedAt: number | null) => ({ id: 'child', turns: [{ id: 't', startedAt: 10, completedAt, status: 'completed', items: [] }] });
    await child.history(thread(null));
    const before = send.mock.lastCall!;
    await child.history(thread(15));
    const enriched = send.mock.lastCall!;
    expect(enriched[0]).toMatchObject({ activityKind: 'turn_snapshot', startedAt: 10_000, completedAt: 15_000 });
    expect(enriched[1]).not.toBe(before[1]);
    child.reset(); await child.history(thread(15));
    expect(send.mock.lastCall).toEqual(enriched);
});

it('attests live own turns from child notifications, never inherited snapshot replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-child-live-provenance-'));
    try {
        const path = join(dir, 'rollout.jsonl');
        await writeFile(path, line('session_meta', { id: 'child', forked_from_id: 'parent' })
            + line('session_meta', { id: 'parent' })
            + line('turn_context', { turn_id: 'parent-turn', model: 'parent-model', effort: 'high' })
            + line('turn_context', { turn_id: 'own-turn', model: 'own-model', effort: 'low' }));
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const child = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        await child.history({ id: 'child', path, turns: [
            { id: 'parent-turn', status: 'completed', items: [] },
            { id: 'own-turn', status: 'inProgress', items: [] }
        ] });
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model)).toBe(false);
        await child.notification('turn/started', { threadId: 'parent', turn: { id: 'own-turn' } });
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model)).toBe(false);
        await child.notification('turn/started', { threadId: 'child', turn: { id: 'own-turn' } });
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'own-model')).toBe(true);
        expect(send.mock.calls.some(([body]) => body.input?.agentExecution?.model === 'parent-model')).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
