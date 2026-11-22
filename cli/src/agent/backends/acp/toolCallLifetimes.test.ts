import { describe, expect, it } from 'vitest';
import {
    AcpToolCallLifetimes,
    MAX_TRACKED_TOOL_CALL_LIFETIMES,
    childToolCallScope,
    formatToolCallLifetimeId,
    parseToolCallLifetimeId
} from './toolCallLifetimes';

function sequentialIds(): (agentId: string) => string {
    let next = 0;
    return (agentId) => `${agentId}#L${++next}`;
}

describe('tool call lifetime ids', () => {
    it('keeps the agent id as a parseable prefix of a UUID lifetime id', () => {
        const id = formatToolCallLifetimeId('question:0');
        expect(id).toMatch(/^question:0#[0-9a-f-]{36}$/);
        expect(parseToolCallLifetimeId(id)).toBe('question:0');
        expect(formatToolCallLifetimeId('question:0')).not.toBe(id);
    });

    it('treats ids without a lifetime suffix as legacy', () => {
        expect(parseToolCallLifetimeId('question:0')).toBeNull();
        expect(parseToolCallLifetimeId('toolu_01#abc')).toBeNull();
        expect(parseToolCallLifetimeId('#3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b')).toBeNull();
    });
});

describe('AcpToolCallLifetimes', () => {
    it('maps a call, its updates and its result to one lifetime', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        expect(lifetimes.resolve('shell:0', 'start')).toBe('shell:0#L1');
        expect(lifetimes.resolve('shell:0', 'update')).toBe('shell:0#L1');
        expect(lifetimes.resolve('shell:0', 'request')).toBe('shell:0#L1');
        expect(lifetimes.resolve('shell:0', 'terminal')).toBe('shell:0#L1');
    });

    it('opens a new lifetime when a finished id is started again, in the same or a later prompt', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        lifetimes.resolve('shell:0', 'start');
        lifetimes.resolve('shell:0', 'terminal');
        expect(lifetimes.resolve('shell:0', 'start')).toBe('shell:0#L2');
        lifetimes.resolve('shell:0', 'terminal');
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('shell:0', 'start')).toBe('shell:0#L3');
    });

    it('maps duplicate and late results to the finished lifetime', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.resolve('shell:0', 'start');
        lifetimes.resolve('shell:0', 'terminal');
        expect(lifetimes.resolve('shell:0', 'terminal')).toBe('shell:0#L1');
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('shell:0', 'update')).toBe('shell:0#L1');
    });

    it('lets a call join the result that arrived before it in the same prompt', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('read:1', 'terminal')).toBe('read:1#L1');
        expect(lifetimes.resolve('read:1', 'start')).toBe('read:1#L1');
        // The joined call is now a normal finished lifetime.
        expect(lifetimes.resolve('read:1', 'start')).toBe('read:1#L2');
    });

    it('does not let a later prompt join an orphan result', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        lifetimes.resolve('read:1', 'terminal');
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('read:1', 'start')).toBe('read:1#L2');
    });

    it('keeps an open call across prompts, user messages and cancels', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        lifetimes.resolve('task:0', 'start');
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('task:0', 'update')).toBe('task:0#L1');
        lifetimes.cancel();
        expect(lifetimes.resolve('task:0', 'update')).toBe('task:0#L1');
        lifetimes.settleCancelled();
        expect(lifetimes.resolve('task:0', 'terminal')).toBe('task:0#L1');
    });

    it('opens a new lifetime for an aborted call id reused after the cancel settles', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        lifetimes.resolve('question:0', 'start');
        lifetimes.resolve('question:0', 'request');
        lifetimes.cancel();
        // Updates of the cancelled call still map to it.
        expect(lifetimes.resolve('question:0', 'update')).toBe('question:0#L1');
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('question:0', 'request')).toBe('question:0#L2');
        expect(lifetimes.resolve('question:0', 'start')).toBe('question:0#L2');
        // A late result of the aborted call can no longer be told apart; it
        // lands on the current lifetime, as the agent's own id does.
        expect(lifetimes.resolve('question:0', 'terminal')).toBe('question:0#L2');
    });

    it('closes an answered call whose result never came once a later prompt begins', () => {
        let next = 0;
        const lifetimes = new AcpToolCallLifetimes((agentId) => formatToolCallLifetimeId(agentId, `00000000-0000-4000-8000-00000000000${++next}`));
        lifetimes.beginGeneration();
        const answered = lifetimes.resolve('question:0', 'start');
        lifetimes.resolve('question:0', 'request');
        lifetimes.settleRequest(answered);
        // Same prompt: the call still runs after its answer.
        expect(lifetimes.resolve('question:0', 'update')).toBe(answered);
        expect(lifetimes.resolve('question:0', 'start')).toBe(answered);
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('question:0', 'update')).toBe(answered);
        expect(lifetimes.resolve('question:0', 'start')).not.toBe(answered);
    });

    it('ignores a settle for a lifetime that is no longer current', () => {
        let next = 0;
        const lifetimes = new AcpToolCallLifetimes((agentId) => formatToolCallLifetimeId(agentId, `00000000-0000-4000-8000-00000000000${++next}`));
        const first = lifetimes.resolve('shell:0', 'start');
        lifetimes.resolve('shell:0', 'terminal');
        const second = lifetimes.resolve('shell:0', 'start');
        lifetimes.settleRequest(first);
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('shell:0', 'start')).toBe(second);
    });

    it('keeps child-session lifetimes out of the parent cancel and generations', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        const child = childToolCallScope('ses_child');
        lifetimes.beginGeneration();
        lifetimes.resolve('ses_child:shell:0', 'start', child);
        lifetimes.cancel();
        lifetimes.beginGeneration();
        expect(lifetimes.resolve('ses_child:shell:0', 'start', child)).toBe('ses_child:shell:0#L1');
        expect(lifetimes.resolve('ses_child:shell:0', 'terminal', child)).toBe('ses_child:shell:0#L1');
        lifetimes.beginGeneration(child);
        expect(lifetimes.resolve('ses_child:shell:0', 'start', child)).toBe('ses_child:shell:0#L2');
    });

    it('closes an interrupted child turn for reuse', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        const child = childToolCallScope('ses_child');
        lifetimes.resolve('ses_child:question:0', 'start', child);
        lifetimes.cancel(child);
        lifetimes.beginGeneration(child);
        expect(lifetimes.resolve('ses_child:question:0', 'update', child)).toBe('ses_child:question:0#L1');
        expect(lifetimes.resolve('ses_child:question:0', 'start', child)).toBe('ses_child:question:0#L2');
    });

    it('keeps the same agent id in a parent and a child session as separate calls', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        const child = childToolCallScope('ses_child');
        lifetimes.beginGeneration();
        const parent = lifetimes.resolve('shell:0', 'start');
        const childCall = lifetimes.resolve('shell:0', 'start', child);
        expect(childCall).not.toBe(parent);
        expect(lifetimes.resolve('shell:0', 'terminal', child)).toBe(childCall);
        // The child's result neither closes nor captures the parent's call.
        expect(lifetimes.resolve('shell:0', 'start')).toBe(parent);
        expect(lifetimes.resolve('shell:0', 'terminal')).toBe(parent);
    });

    it("joins a child's open call when its request names the root session", () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        const childCall = lifetimes.resolve('ses_child:edit:1', 'start', childToolCallScope('ses_child'));
        expect(lifetimes.resolve('ses_child:edit:1', 'request')).toBe(childCall);
    });

    it('keeps a second permission of the same call on its card after a later prompt began', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        const call = lifetimes.resolve('edit:1', 'start');
        const first = lifetimes.allocateRequestId(lifetimes.resolve('edit:1', 'request'));
        lifetimes.settleRequest(call);
        lifetimes.beginGeneration();
        const lifetime = lifetimes.resolve('edit:1', 'request');
        expect(lifetime).toBe(call);
        const second = lifetimes.allocateRequestId(lifetime);
        expect(first).toBe(call);
        // URL-safe suffix: the request id travels in permission routes.
        expect(second).toMatch(/^edit:1#L1~[0-9a-f-]{36}$/);
    });

    it('rebuilds stored open lifetimes: their events and requests keep the stored id, a fresh start does not', () => {
        const stored = formatToolCallLifetimeId('question:0', '3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b');
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.restore([
            { agentToolCallId: 'question:0', scope: 'main', id: stored },
            { agentToolCallId: 'shell:0', scope: childToolCallScope('ses_child'), id: 'shell:0#S' }
        ]);
        expect(lifetimes.resolve('question:0', 'update')).toBe(stored);
        expect(lifetimes.resolve('question:0', 'request')).toBe(stored);
        // The earlier request died with the old process: the re-ask gets its own id.
        expect(lifetimes.allocateRequestId(stored)).toMatch(new RegExp(`^${stored}~`));
        expect(lifetimes.resolve('shell:0', 'terminal', childToolCallScope('ses_child'))).toBe('shell:0#S');
        // A fresh start comes from the new process: never the stored lifetime.
        expect(lifetimes.resolve('question:0', 'start')).toBe('question:0#L1');
    });

    it('lists only lifetimes that may still receive events', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.resolve('done:0', 'start');
        lifetimes.resolve('done:0', 'terminal');
        lifetimes.resolve('running:0', 'start');
        lifetimes.resolve('aborted:0', 'start');
        lifetimes.cancel();
        lifetimes.resolve('late:0', 'start');
        // Cancelled calls may still report (a background command), so they stay.
        expect(lifetimes.openLifetimes().map((entry) => entry.id)).toEqual(['running:0#L2', 'aborted:0#L3', 'late:0#L4']);
    });

    it('reports changes of the open set', () => {
        let changes = 0;
        const lifetimes = new AcpToolCallLifetimes(sequentialIds(), () => { changes += 1; });
        lifetimes.resolve('shell:0', 'start');
        lifetimes.resolve('shell:0', 'update');
        lifetimes.resolve('shell:0', 'terminal');
        expect(changes).toBe(2);
    });

    it('does not let a stored id replace a lifetime of the live connection', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.resolve('question:0', 'start');
        lifetimes.restore([{ agentToolCallId: 'question:0', scope: 'main', id: 'question:0#OLD' }]);
        expect(lifetimes.resolve('question:0', 'request')).toBe('question:0#L1');
    });

    it('forgets finished lifetimes first and keeps a running call', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.resolve('long:0', 'start');
        for (let i = 0; i < MAX_TRACKED_TOOL_CALL_LIFETIMES + 100; i += 1) {
            lifetimes.resolve(`call_${i}`, 'start');
            lifetimes.resolve(`call_${i}`, 'terminal');
        }
        expect(lifetimes.resolve('long:0', 'terminal')).toBe('long:0#L1');
        // Forgotten: a very late duplicate opens a lifetime of its own.
        expect(lifetimes.resolve('call_0', 'terminal')).not.toBe('call_0#L2');
    });

    it('stays bounded when calls never report a result, forgetting earlier prompts first', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        for (let i = 0; i < MAX_TRACKED_TOOL_CALL_LIFETIMES; i += 1) {
            lifetimes.resolve(`stale_${i}`, 'start');
        }
        lifetimes.beginGeneration();
        const current = lifetimes.resolve('current:0', 'start');
        for (let i = 0; i < 100; i += 1) {
            lifetimes.resolve(`more_${i}`, 'start');
        }
        expect(lifetimes.openLifetimes().length).toBeLessThanOrEqual(MAX_TRACKED_TOOL_CALL_LIFETIMES);
        expect(lifetimes.resolve('current:0', 'update')).toBe(current);
        expect(lifetimes.resolve('more_99', 'update')).toMatch(/^more_99#L/);
    });

    it('opens a new lifetime for the same id started right after a cancel, before it settles', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        const aborted = lifetimes.resolve('shell:0', 'start');
        lifetimes.cancel();
        const next = lifetimes.resolve('shell:0', 'start');
        expect(next).not.toBe(aborted);
        lifetimes.settleCancelled();
        // The new call is not cancelled by the settle of the old one.
        expect(lifetimes.resolve('shell:0', 'start')).toBe(next);
    });

    it('keeps a cancelled call that may still report in the persisted set', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.resolve('bg:0', 'start');
        lifetimes.cancel();
        expect(lifetimes.openLifetimes().map((entry) => entry.id)).toEqual(['bg:0#L1']);
    });

    it('tells the listener whether a lifetime opened, so opening can be written at once', () => {
        const changes: string[] = [];
        const lifetimes = new AcpToolCallLifetimes(sequentialIds(), (change) => { changes.push(change); });
        lifetimes.resolve('shell:0', 'start');
        lifetimes.resolve('shell:0', 'terminal');
        lifetimes.resolve('read:0', 'terminal');
        expect(changes).toEqual(['open', 'close', 'open', 'close']);
    });

    it('restores a stored call however long it has been open', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.restore([{ agentToolCallId: 'bg:0', scope: 'main', id: 'bg:0#S', openedAt: Date.now() - 30 * 24 * 3600_000 }]);
        expect(lifetimes.resolve('bg:0', 'terminal')).toBe('bg:0#S');
    });

    it('does not let a start join a call cancelled before any start was seen', () => {
        const lifetimes = new AcpToolCallLifetimes(sequentialIds());
        lifetimes.beginGeneration();
        const updated = lifetimes.resolve('shell:0', 'update');
        const asked = lifetimes.resolve('ask:0', 'request');
        lifetimes.cancel();
        expect(lifetimes.resolve('shell:0', 'start')).not.toBe(updated);
        expect(lifetimes.resolve('ask:0', 'start')).not.toBe(asked);
    });

    it('hands the opened lifetime to the listener so it can be journaled alone', () => {
        const opened: Array<string | undefined> = [];
        const lifetimes = new AcpToolCallLifetimes(sequentialIds(), (change, lifetime) => {
            if (change === 'open') opened.push(lifetime?.id);
        });
        lifetimes.resolve('shell:0', 'start');
        expect(opened).toEqual(['shell:0#L1']);
    });
});
