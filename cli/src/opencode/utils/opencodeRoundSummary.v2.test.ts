import { describe, expect, it, vi } from 'vitest';
import { captureOpencodeRoundSnapshot, fetchOpencodeRoundSummary } from './opencodeRoundSummary';

const signal = new AbortController().signal;
const api = { version: 'v2' as const, password: 'fixture-password' };
const base = { baseUrl: 'http://127.0.0.1:48273', sessionId: 'session/id', signal, api };
const user = { id: 'prompt', type: 'user', text: 'round prompt' };
const assistant = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, type: 'assistant', model: { providerID: 'fixture', id: 'model' },
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 3 } }, cost: 0,
    ...overrides
});
function request(data: unknown) {
    return {
        ...base, promptText: user.text, snapshot: { messageIds: ['old'] }, durationMs: 100,
        fetchImpl: vi.fn(async () => Response.json({ data }))
    };
}

describe('OpenCode v2 round usage', () => {
    it('captures flat IDs using the authenticated v2 endpoint at its server page limit', async () => {
        const opts = request([{ id: 'old', type: 'idle' }]);
        await expect(captureOpencodeRoundSnapshot(opts)).resolves.toEqual({ messageIds: ['old'] });
        expect(opts.fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:48273/api/session/session%2Fid/message?limit=200',
            expect.objectContaining({ method: 'GET', headers: { authorization: 'Basic b3BlbmNvZGU6Zml4dHVyZS1wYXNzd29yZA==' } })
        );
    });

    it('aggregates assistant and billed compaction calls while excluding native compaction and control rows', async () => {
        const opts = request([
            assistant('final', { cost: 0.03 }),
            { id: 'synthetic', type: 'synthetic', text: 'continue' },
            assistant('compact', { type: 'compaction', status: 'completed', cost: 0.01 }),
            { id: 'native-compact', type: 'compaction', status: 'completed', native: { messages: [] } },
            assistant('tool'), user, { id: 'old', type: 'idle' }
        ]);
        const result = await fetchOpencodeRoundSummary(opts);
        expect(result?.summary).toEqual({
            usage: { inputTokens: 30, outputTokens: 9, cacheReadInputTokens: 15, cacheCreationInputTokens: 9 },
            modelUsage: { 'fixture/model': { inputTokens: 30, outputTokens: 9, cacheReadInputTokens: 15, cacheCreationInputTokens: 9 } },
            totalCostUsd: 0.04, numTurns: 3, durationMs: 100
        });
        expect(opts.fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:48273/api/session/session%2Fid/message?limit=200', expect.anything()
        );
    });

    it('preserves valid tokens but omits round cost if any v2 call has no cost', async () => {
        const result = await fetchOpencodeRoundSummary(request([user, assistant('one', { cost: 0.03 }), assistant('two', { cost: undefined })]));
        expect(result?.summary).toMatchObject({ numTurns: 2, usage: { inputTokens: 20, outputTokens: 6 } });
        expect(result?.summary).not.toHaveProperty('totalCostUsd');
    });

    it.each([
        [null], [user, { id: 'bad', type: 'assistant' }], [user, assistant('same'), assistant('same')],
        [assistant('outside-window')], [user, assistant('bad', { tokens: { input: -1 } })],
        [user, assistant('bad', { cost: null })], [user, assistant('bad', { model: [] })],
        [user, assistant('bad', { type: 'compaction', status: 'running' })]
    ])('fails closed for malformed or unassociated messages %j', async (...data) => {
        const result = await fetchOpencodeRoundSummary(request(data));
        expect(result?.summary ?? null).toBeNull();
    });

    it('rejects malformed envelope and pre-snapshot identity failures without throwing', async () => {
        for (const data of [[null], [user, user]]) {
            await expect(captureOpencodeRoundSnapshot(request(data))).resolves.toBeNull();
        }
        await expect(captureOpencodeRoundSnapshot({ ...base, fetchImpl: vi.fn(async () => Response.json([])) })).resolves.toBeNull();
    });

    it('omits optional metadata on unauthorized, malformed, or stalled v2 responses', async () => {
        for (const response of [new Response('not authorized', { status: 401 }), new Response('{', { status: 200 })]) {
            await expect(captureOpencodeRoundSnapshot({ ...base, fetchImpl: vi.fn(async () => response) })).resolves.toBeNull();
        }
        await expect(captureOpencodeRoundSnapshot({
            ...base, timeoutMs: 10,
            fetchImpl: vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response)
        })).resolves.toBeNull();
    });
});


describe('OpenCode v2 provider throughput', () => {
    const step = (id: string, time: unknown = { created: 1_000, streamed: 1_500, completed: 9_000 }) => assistant(id, { time });

    it('weights all assistant steps including reasoning, excluding tool settlement and billed compaction', async () => {
        const result = await fetchOpencodeRoundSummary(request([
            user, step('tool'), step('final', { created: 10_000, streamed: 11_000 }),
            assistant('compact', { type: 'compaction', status: 'completed' })
        ]));
        expect(result?.summary).toMatchObject({
            usage: { outputTokens: 9 }, numTurns: 3, durationMs: 100,
            generationMs: 1_500, generationOutputTokens: 6
        });
    });

    it.each([
        { interval: 'zero', time: { created: 1_000, streamed: 1_000 }, invalidFirst: true },
        { interval: 'zero', time: { created: 1_000, streamed: 1_000 }, invalidFirst: false },
        { interval: 'reversed', time: { created: 1_000, streamed: 999 }, invalidFirst: true },
        { interval: 'reversed', time: { created: 1_000, streamed: 999 }, invalidFirst: false }
    ])('omits both generation fields for a mixed $interval interval (invalid first: $invalidFirst)', async ({ time, invalidFirst }) => {
        const invalid = { ...step('invalid', time), cost: 0.01 };
        const valid = { ...step('valid'), cost: 0.02 };
        const result = await fetchOpencodeRoundSummary(request([user, ...(invalidFirst ? [invalid, valid] : [valid, invalid])]));
        expect(result?.summary).not.toHaveProperty('generationMs');
        expect(result?.summary).not.toHaveProperty('generationOutputTokens');
        expect(result?.summary).toEqual({
            usage: { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 10, cacheCreationInputTokens: 6 },
            modelUsage: { 'fixture/model': { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 10, cacheCreationInputTokens: 6 } },
            totalCostUsd: 0.03, numTurns: 2, durationMs: 100
        });
    });

    it('ignores invalid compaction timing while preserving the positive assistant-only pair and billed totals', async () => {
        const result = await fetchOpencodeRoundSummary(request([
            user, { ...step('valid'), cost: 0.02 },
            assistant('compact', { type: 'compaction', status: 'completed', cost: 0.01, time: { created: 10, streamed: 9 } })
        ]));
        expect(result?.summary).toEqual({
            usage: { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 10, cacheCreationInputTokens: 6 },
            modelUsage: { 'fixture/model': { inputTokens: 20, outputTokens: 6, cacheReadInputTokens: 10, cacheCreationInputTokens: 6 } },
            totalCostUsd: 0.03, numTurns: 2, durationMs: 100,
            generationMs: 500, generationOutputTokens: 3
        });
    });

    it.each([
        undefined, null, [], {}, { streamed: 20 }, { created: 10 },
        { created: -1, streamed: 20 }, { created: 10, streamed: Infinity },
        { created: NaN, streamed: 20 }, { created: 1, streamed: Number.MAX_SAFE_INTEGER + 1 }, { created: '10', streamed: 20 },
        { created: 10, streamed: 10 }, { created: 20, streamed: 10 }
    ])('preserves usage while omitting throughput for incomplete or zero time %j', async (time) => {
        const result = await fetchOpencodeRoundSummary(request([user, assistant('one', { time })]));
        expect(result?.summary).toMatchObject({ usage: { outputTokens: 3 } });
        expect(result?.summary).not.toHaveProperty('generationMs');
        expect(result?.summary).not.toHaveProperty('generationOutputTokens');
    });

    it('hides the whole rate when just one assistant boundary is missing', async () => {
        const result = await fetchOpencodeRoundSummary(request([user, step('valid'), step('missing', {})]));
        expect(result?.summary).toMatchObject({ numTurns: 2 });
        expect(result?.summary).not.toHaveProperty('generationMs');
    });

    it('omits throughput for zero output and v1 even if timestamps are present', async () => {
        const zero = await fetchOpencodeRoundSummary(request([user, assistant('zero', {
            time: { created: 1, streamed: 100 },
            tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        })]));
        expect(zero?.summary).not.toHaveProperty('generationMs');
        const opts = request([]);
        const v1 = await fetchOpencodeRoundSummary({ ...opts, api: undefined, fetchImpl: async () => Response.json([
            { info: { id: user.id, role: 'user' }, parts: [{ type: 'text', text: user.text }] },
            { info: { ...step('one'), role: 'assistant', providerID: 'fixture', modelID: 'model' } }
        ]) });
        expect(v1?.summary).toMatchObject({ numTurns: 1 });
        expect(v1?.summary).not.toHaveProperty('generationMs');
    });
});
