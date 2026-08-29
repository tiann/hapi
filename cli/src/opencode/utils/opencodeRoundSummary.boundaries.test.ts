import { describe, expect, it, vi } from 'vitest';
import { captureOpencodeRoundSnapshot, fetchOpencodeRoundSummary } from './opencodeRoundSummary';

const signal = new AbortController().signal;
const base = { baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', signal };

const user = (id: string, text: string) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] });
const assistant = (id: string) => ({
    info: {
        id,
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.4',
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0
    }
});

describe('OpenCode round message identity boundary', () => {
    it('fails closed for duplicate message ids in the pre-snapshot or post-fetch response', async () => {
        await expect(captureOpencodeRoundSnapshot({
            ...base,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify([user('same', 'one'), user('same', 'two')]), { status: 200 }))
        })).resolves.toBeNull();

        await expect(fetchOpencodeRoundSummary({
            ...base,
            promptText: 'prompt',
            snapshot: { messageIds: ['old'] },
            durationMs: 1,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify([
                user('old', 'earlier'), user('prompt-user', 'prompt'), assistant('assistant-1'), assistant('assistant-1')
            ]), { status: 200 }))
        })).resolves.toBeNull();
    });

    it('abandons a stalled message API request after its bounded timeout', async () => {
        const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));

        await expect(captureOpencodeRoundSnapshot({ ...base, timeoutMs: 1, fetchImpl })).resolves.toBeNull();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('bounds the whole response parse, including a response whose json never settles', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: () => new Promise<unknown>(() => {}) }));
        await expect(captureOpencodeRoundSnapshot({ ...base, timeoutMs: 1, fetchImpl: fetchImpl as never })).resolves.toBeNull();
    });

    it('checks a large snapshot identity list with a Set-backed duplicate invariant', async () => {
        const messages = Array.from({ length: 10_000 }, (_, index) => user('message-' + index, 'fixture'));
        await expect(captureOpencodeRoundSnapshot({
            ...base,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify(messages), { status: 200 }))
        })).resolves.toMatchObject({ messageIds: expect.arrayContaining(['message-0', 'message-9999']) });
    });
});
