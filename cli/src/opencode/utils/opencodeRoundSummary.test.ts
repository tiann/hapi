import { describe, expect, it, vi } from 'vitest';
import { captureOpencodeRoundSnapshot, fetchOpencodeRoundSummary } from './opencodeRoundSummary';

const noSignal = new AbortController().signal;

function user(id: string, text: string) {
    return { info: { id, role: 'user' }, parts: [{ type: 'text', text }] };
}

function assistant(id: string, parentID: string, overrides: Record<string, unknown> = {}) {
    return {
        info: {
            id,
            role: 'assistant',
            parentID,
            providerID: 'openai',
            modelID: 'gpt-5.4',
            tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            ...overrides
        },
        parts: [{ type: 'step-finish' }]
    };
}

function options(messages: unknown[], promptText = 'original prompt') {
    return {
        baseUrl: 'http://127.0.0.1:48273',
        sessionId: 'ses_abc',
        promptText,
        snapshot: { messageIds: ['old-user', 'old-assistant'] },
        durationMs: 1_250,
        signal: noSignal,
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(messages), { status: 200 }))
    };
}

describe('captureOpencodeRoundSnapshot', () => {
    it('captures only valid persisted message IDs before a prompt', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/message');
            expect(init).toMatchObject({ method: 'GET', signal: noSignal });
            return new Response(JSON.stringify([user('old-user', 'earlier'), assistant('old-assistant', 'old-user')]), { status: 200 });
        });

        await expect(captureOpencodeRoundSnapshot({
            baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', signal: noSignal, fetchImpl
        })).resolves.toEqual({ messageIds: ['old-user', 'old-assistant'] });
    });

    it('fails closed for a non-2xx response or malformed message id', async () => {
        await expect(captureOpencodeRoundSnapshot({
            baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', signal: noSignal,
            fetchImpl: vi.fn(async () => new Response('nope', { status: 404 }))
        })).resolves.toBeNull();
        await expect(captureOpencodeRoundSnapshot({
            baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', signal: noSignal,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify([{ info: { id: 9, role: 'user' } }]), { status: 200 }))
        })).resolves.toBeNull();
    });
});

describe('fetchOpencodeRoundSummary', () => {
    it('aggregates multi-step and multi-model assistant rows, including cache, reasoning, and positive cost', async () => {
        const messages = [
            user('old-user', 'earlier'),
            assistant('old-assistant', 'old-user'),
            user('prompt-user', 'original prompt'),
            assistant('tool-step', 'prompt-user', {
                tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } }, cost: 0.01
            }),
            assistant('stop-step', 'prompt-user', {
                tokens: { input: 40, output: 7, reasoning: 3, cache: { read: 5, write: 0 } }, cost: 0.024
            }),
            assistant('other-model', 'prompt-user', {
                providerID: 'anthropic', modelID: 'claude-opus-4-1',
                tokens: { input: 80, output: 9, reasoning: 0, cache: { read: 20, write: 0 } }, cost: 0
            })
        ];

        await expect(fetchOpencodeRoundSummary(options(messages))).resolves.toEqual({
            usage: {
                inputTokens: 220,
                outputTokens: 44,
                cacheReadInputTokens: 75,
                cacheCreationInputTokens: 10
            },
            modelUsage: {
                'openai/gpt-5.4': {
                    inputTokens: 140,
                    outputTokens: 35,
                    cacheReadInputTokens: 55,
                    cacheCreationInputTokens: 10
                },
                'anthropic/claude-opus-4-1': {
                    inputTokens: 80,
                    outputTokens: 9,
                    cacheReadInputTokens: 20,
                    cacheCreationInputTokens: 0
                }
            },
            totalCostUsd: 0.034,
            numTurns: 3,
            durationMs: 1_250
        });
    });

    it('includes tool-only, auto-compaction summary, and continuation assistants from every new parent', async () => {
        const messages = [
            user('old-user', 'earlier'),
            assistant('old-assistant', 'old-user'),
            user('prompt-user', 'original prompt'),
            assistant('tool-only', 'prompt-user'),
            user('compact-user', 'automatic compact'),
            assistant('compact-summary', 'compact-user', { summary: true, tokens: { input: 20, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
            user('continuation-user', 'continue'),
            assistant('continuation', 'continuation-user', { tokens: { input: 30, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } })
        ];

        const result = await fetchOpencodeRoundSummary(options(messages));
        expect(result).toMatchObject({ numTurns: 3, usage: { inputTokens: 60, outputTokens: 9 } });
    });

    it('omits zero cost while preserving a valid free round', async () => {
        const messages = [user('old-user', 'earlier'), assistant('old-assistant', 'old-user'), user('prompt-user', 'original prompt'), assistant('new', 'prompt-user')];
        const result = await fetchOpencodeRoundSummary(options(messages));
        expect(result).toMatchObject({ numTurns: 1 });
        expect(result).not.toHaveProperty('totalCostUsd');
    });

    it('fails closed for missing original prompt, no assistant, malformed model/token shapes, unsafe counters, and non-finite numbers', async () => {
        const base = [user('old-user', 'earlier'), assistant('old-assistant', 'old-user')];
        await expect(fetchOpencodeRoundSummary(options([...base, assistant('new', 'unknown')]))).resolves.toBeNull();
        await expect(fetchOpencodeRoundSummary(options([...base, user('prompt-user', 'original prompt')]))).resolves.toBeNull();
        await expect(fetchOpencodeRoundSummary(options([...base, user('prompt-user', 'original prompt'), assistant('bad-model', 'prompt-user', { modelID: '' })]))).resolves.toBeNull();
        await expect(fetchOpencodeRoundSummary(options([...base, user('prompt-user', 'original prompt'), assistant('unsafe', 'prompt-user', { tokens: { input: Number.MAX_SAFE_INTEGER + 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })]))).resolves.toBeNull();
        await expect(fetchOpencodeRoundSummary(options([...base, user('prompt-user', 'original prompt'), assistant('infinite-cost', 'prompt-user', { cost: Infinity })]))).resolves.toBeNull();
    });

    it('fails closed for a post-fetch API or parse failure without exposing the response body', async () => {
        await expect(fetchOpencodeRoundSummary({ ...options([]), fetchImpl: vi.fn(async () => new Response('provider secret', { status: 500 })) })).resolves.toBeNull();
        await expect(fetchOpencodeRoundSummary({ ...options([]), fetchImpl: vi.fn(async () => new Response('{', { status: 200 })) })).resolves.toBeNull();
    });
});
