import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexCompactionSummaryLookup } from './codexCompactionSummary';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const meta = { type: 'session_meta', payload: { id: 'thread', session_id: 'thread' } };
const start = (turn = 'turn') => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
const checkpoint = (message = 'Native summary', turn = 'turn') => ({ type: 'compacted', payload: {
    message, resume_metadata: { last_started_turn_id: turn },
    replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Actual user prompt, never a summary' }] }]
} });
const completed = (id = 'compact', turn = 'turn', thread = 'thread') => ({ type: 'event_msg', payload: {
    type: 'item_completed', thread_id: thread, turn_id: turn, item: { type: 'ContextCompaction', id }
} });
const lines = (...events: unknown[]) => events.map(x => JSON.stringify(x) + '\n').join('');
async function fixture(content: string) {
    const dir = await mkdtemp(join(tmpdir(), 'codex-summary-')); dirs.push(dir);
    const path = join(dir, 'rollout.jsonl'); await writeFile(path, content);
    return { path, thread: { id: 'thread', path }, lookup: new CodexCompactionSummaryLookup('thread') };
}

describe('exact Codex checkpoint summary lookup', () => {
    it('returns only the checkpoint bound to the exact thread, turn and completed compaction', async () => {
        const f = await fixture(lines(meta, start(), checkpoint('First summary'), completed(), start('next'), checkpoint('Second summary', 'next'), completed('c2', 'next')));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual({ summary: 'First summary' });
        expect(await f.lookup.find(f.thread, 'next', 'c2', { attempts: 1 })).toEqual({ summary: 'Second summary' });
        expect(await f.lookup.find(f.thread, 'turn', 'c2', { attempts: 1 })).toBeNull();
        expect(await f.lookup.find({ ...f.thread, id: 'other' }, 'turn', 'compact', { attempts: 1 })).toBeNull();
    });
    it.each([
        'not-json\n' + lines(meta, start(), checkpoint(), completed()),
        lines({ ...meta, payload: { id: 'other' } }, start(), checkpoint(), completed()),
        lines(meta, start(), checkpoint(), completed('compact', 'turn', 'other')),
        lines(meta, start(), checkpoint('Wrong turn', 'other'), completed()),
        lines(meta, start(), checkpoint(), checkpoint('Ambiguous'), completed()),
        lines(meta, start(), checkpoint(), { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn' } }, completed()),
        lines(meta, start(), checkpoint(), { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage' } } }, completed())
    ])('fails closed for wrong identity, ambiguous or interrupted checkpoint (%#)', async content => {
        const f = await fixture(content);
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toBeNull();
    });
    it('serializes concurrent live/history readers of the same checkpoint', async () => {
        const f = await fixture(lines(meta, start(), checkpoint(), completed()));
        const results = await Promise.all(Array.from({ length: 8 }, () => f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })));
        expect(results).toEqual(Array(8).fill({ summary: 'Native summary' }));
    });
    it.each(['Native summary', ''])('extracts only the exact post-checkpoint retained-context estimate (%j)', async summary => {
        const estimate = { type: 'event_msg', payload: { type: 'token_count', info: {
            total_token_usage: { total_tokens: 999999 }, last_usage_includes_reasoning: true,
            last_token_usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 18335 }
        } } };
        const f = await fixture(lines(meta, start(), checkpoint(summary), { type: 'turn_context', payload: { turn_id: 'turn' } }, estimate, completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual({ ...(summary ? { summary } : {}), estimatedTokensAfter: 18335 });
    });
    it.each([0, -1, null])('preserves explicit estimated zero and rejects invalid values (%j)', async total => {
        const f = await fixture(lines(meta, start(), checkpoint(''), { type: 'turn_context', payload: { turn_id: 'turn' } },
            { type: 'event_msg', payload: { type: 'token_count', info: { last_usage_includes_reasoning: true, last_token_usage: {
                input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total
            } } } }, completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual(total === 0 ? { estimatedTokensAfter: 0 } : null);
    });
    it.each(['missing-context', 'wrong-context', 'late-wrong-context', 'duplicate', 'new-model-record', 'missing-estimate-marker'])('omits an estimate when its native recompute window is unproven (%s)', async kind => {
        const estimate = { type: 'event_msg', payload: { type: 'token_count', info: {
            last_usage_includes_reasoning: kind !== 'missing-estimate-marker', last_token_usage: {
                input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 123
            }
        } } };
        const context = { type: 'turn_context', payload: { turn_id: kind === 'wrong-context' ? 'other' : 'turn' } };
        const f = await fixture(lines(meta, start(), checkpoint('Native summary'), ...(kind === 'missing-context' ? [] : [context]), estimate,
            ...(kind === 'duplicate' ? [estimate] : []), ...(kind === 'new-model-record' ? [{ type: 'token_usage_record', payload: {} }] : []),
            ...(kind === 'late-wrong-context' ? [{ type: 'turn_context', payload: { turn_id: 'other' } }] : []), completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual({ summary: 'Native summary' });
    });
    it('does not promote model/cumulative usage or an unbound estimate into compaction context', async () => {
        const model = { type: 'event_msg', payload: { type: 'token_count', info: {
            total_token_usage: { total_tokens: 99999 }, last_usage_includes_reasoning: true,
            last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 100 }
        } } };
        const f = await fixture(lines(meta, start(), model, checkpoint('Native summary'), { type: 'turn_context', payload: { turn_id: 'turn' } }, model, completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual({ summary: 'Native summary' });
    });
    it('does not treat remote opaque state or retained user messages as a summary', async () => {
        const f = await fixture(lines(meta, start(), checkpoint(''), completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toBeNull();
    });
    it('waits for the exact completed marker and complete JSONL line, never the latest other summary', async () => {
        const f = await fixture(lines(meta, start(), checkpoint('Earlier'), completed(), start('next'), checkpoint('Fresh', 'next')) + JSON.stringify(completed('c2', 'next')));
        expect(await f.lookup.find(f.thread, 'next', 'c2', { attempts: 1 })).toBeNull();
        await appendFile(f.path, '\n');
        expect(await f.lookup.find(f.thread, 'next', 'c2', { attempts: 1 })).toEqual({ summary: 'Fresh' });
    });
    it('retries a delayed flush using the same exact path only', async () => {
        const f = await fixture(lines(meta, start(), checkpoint()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 2, sleep: async () => { await appendFile(f.path, lines(completed())); } })).toEqual({ summary: 'Native summary' });
    });
    it('invalidates cached results after file replacement or truncation', async () => {
        const f = await fixture(lines(meta, start(), checkpoint(), completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toEqual({ summary: 'Native summary' });
        await rename(f.path, f.path + '.old'); await writeFile(f.path, lines({ ...meta, payload: { id: 'other' } }, start(), checkpoint('Other'), completed()));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toBeNull();
        await writeFile(f.path, lines(meta));
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 })).toBeNull();
    });
    it.skipIf(process.platform === 'win32')('does not block on a FIFO substituted for the native path', async () => {
        const f = await fixture(lines(meta)); await rm(f.path); execFileSync('mkfifo', [f.path]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                f.lookup.find(f.thread, 'turn', 'compact', { attempts: 1 }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FIFO lookup blocked')), 500); })
            ]);
            expect(result).toBeNull();
        } finally {
            clearTimeout(timer);
            // Release a blocked reader when mutation-testing the missing guard.
            const writer = await open(f.path, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => undefined);
            await writer?.close();
        }
    });
    it('does not poll a permanently wrong session header', async () => {
        const f = await fixture(lines({ ...meta, payload: { id: 'other' } }));
        let sleeps = 0;
        expect(await f.lookup.find(f.thread, 'turn', 'compact', { sleep: async () => { sleeps++; } })).toBeNull();
        expect(sleeps).toBe(0);
    });
    it('skips unavailable or unbound paths', async () => {
        const f = await fixture(lines(meta));
        expect(await f.lookup.find({ id: 'thread', path: null }, 'turn', 'compact', { attempts: 1 })).toBeNull();
        expect(await f.lookup.find({ id: 'thread', path: f.path + '.missing' }, 'turn', 'compact', { attempts: 1 })).toBeNull();
    });
});
