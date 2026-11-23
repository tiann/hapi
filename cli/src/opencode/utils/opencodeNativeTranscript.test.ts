import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpencodeNativeTranscript } from './opencodeNativeTranscript';

function setup(fetchImpl = vi.fn(async () => Response.json([]))) {
    const onSummary = vi.fn();
    const onText = vi.fn();
    const onReadFailure = vi.fn();
    const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1', fetchImpl: fetchImpl, onSummary, onText, onReadFailure });
    return { transcript, onSummary, onText, onReadFailure, fetchImpl };
}

describe('OpenCode native transcript reconciliation', () => {
    afterEach(() => vi.useRealTimers());
    it('primes historical text without replay, then retains deltas after a snapshot and flushes terminal text', async () => {
        const fetchImpl = vi.fn(async () => Response.json([{ info: { id: 'answer', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'old' }] }]));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        expect(onText).not.toHaveBeenCalled();
        transcript.event('message.part.delta', { partID: 'part', field: 'text', delta: ' new' });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'old new', complete: false }));
        transcript.close();
    });
    it('primes the first successful historical snapshot after a failed initial read without replaying it', async () => {
        const history = [{ info: { id: 'old', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'old-part', messageID: 'old', sessionID: 'ses', type: 'text', text: 'Existing local answer', time: { end: 1 } }] }];
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockImplementation(async () => Response.json(history));
        const { transcript, onText, onReadFailure } = setup(fetchImpl);
        await transcript.refresh();
        expect(onReadFailure).toHaveBeenCalledOnce();
        await transcript.refresh();
        await transcript.refresh();
        expect(onText).not.toHaveBeenCalled();
        transcript.event('message.updated', { info: { id: 'next', sessionID: 'ses', role: 'assistant' } });
        transcript.event('message.part.updated', { part: { id: 'next-part', messageID: 'next', sessionID: 'ses', type: 'text', text: 'New answer', time: { end: 1 } } });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'next-part', text: 'New answer', complete: true }));
        transcript.close();
    });
    it.each([true, false])('recovers post-attachment replies from the first snapshot without SSE (initial failure: %s)', async (initialFailure) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const entry = (id: string, created: number | string | undefined, sessionID = 'ses') => ({
            info: { id, sessionID, role: 'assistant', time: { created } },
            parts: [{ id: `${id}-part`, messageID: id, sessionID, type: 'text', text: id, time: { end: 1 } }]
        });
        const fetchImpl = vi.fn();
        if (initialFailure) fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 }));
        fetchImpl.mockImplementation(async () => Response.json([
            entry('Historical answer', 999), entry('Recovered new answer', 1_001),
            entry('Missing timestamp', undefined), entry('Invalid timestamp', '1001'), entry('Foreign answer', 1_001, 'foreign')
        ]));
        const { transcript, onText } = setup(fetchImpl);
        if (initialFailure) await transcript.refresh();
        await transcript.refresh();
        await transcript.refresh();
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Recovered new answer', complete: true }));
        transcript.close();
    });
    it('retains live text during baseline recovery without replaying unrelated historical text', async () => {
        const live = { id: 'live-part', messageID: 'live', sessionID: 'ses', type: 'text', text: 'Live answer', time: { end: 1 } };
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockImplementation(async () => Response.json([
                { info: { id: 'old', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'old-part', messageID: 'old', sessionID: 'ses', type: 'text', text: 'Historical answer' }] },
                { info: { id: 'live', sessionID: 'ses', role: 'assistant' }, parts: [live] }
            ]));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        transcript.event('message.part.updated', { part: { ...live, text: 'Live' } });
        transcript.event('message.updated', { info: { id: 'live', sessionID: 'ses', role: 'assistant' } });
        transcript.event('message.part.updated', { part: live });
        expect(onText).not.toHaveBeenCalled();
        await transcript.refresh();
        await transcript.refresh();
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'live-part', text: 'Live answer', complete: true }));
        transcript.close();
    });
    it('recovers a live delta that arrives before its full part during baseline recovery', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockImplementation(async () => Response.json([{ info: { id: 'live', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'live-part', messageID: 'live', sessionID: 'ses', type: 'text', text: 'Complete live answer', time: { end: 1 } }] }]));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        transcript.event('message.part.delta', { sessionID: 'ses', partID: 'live-part', field: 'text', delta: 'answer' });
        transcript.event('message.part.delta', { sessionID: 'foreign', partID: 'old-part', field: 'text', delta: 'foreign' });
        await transcript.refresh();
        await transcript.refresh();
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'live-part', text: 'Complete live answer', complete: true }));
        transcript.close();
    });
    it.each([true, false])('keeps live delta text when the recovered durable part is still empty (known base: %s)', async (knownBase) => {
        vi.useFakeTimers();
        const part = { id: 'live-part', messageID: 'live', sessionID: 'ses', type: 'text', text: '' };
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockImplementation(async () => Response.json([{ info: { id: 'live', sessionID: 'ses', role: 'assistant' }, parts: [part] }]));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'live', sessionID: 'ses', role: 'assistant' } });
        if (knownBase) transcript.event('message.part.updated', { part });
        transcript.event('message.part.delta', { sessionID: 'ses', partID: 'live-part', field: 'text', delta: 'A' });
        await transcript.refresh();
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'A' }));
        await transcript.refresh();
        expect(onText).toHaveBeenCalledOnce();
        transcript.event('message.part.delta', { sessionID: 'ses', partID: 'live-part', field: 'text', delta: 'B' });
        await vi.advanceTimersByTimeAsync(120);
        expect(onText).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'AB', complete: false }));
        transcript.event('message.part.updated', { part: { ...part, text: 'AB', time: { end: 1 } } });
        expect(onText).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'AB', complete: true }));
        expect(onText.mock.calls.some(c => c[0].text === '' || c[0].text === 'B')).toBe(false);
        transcript.close();
    });
    it('does not flush buffered recovery text after close while the baseline read is in flight', async () => {
        let resolve!: (response: Response) => void;
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
        const { transcript, onText } = setup(fetchImpl);
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'live', sessionID: 'ses', role: 'assistant' } });
        transcript.event('message.part.updated', { part: { id: 'live-part', messageID: 'live', sessionID: 'ses', type: 'text', text: 'Buffered answer', time: { end: 1 } } });
        const recovering = transcript.refresh();
        transcript.close();
        resolve(Response.json([]));
        await recovering;
        expect(onText).not.toHaveBeenCalled();
    });
    it('suppresses inherited compaction outcomes while post-baseline ones still publish', async () => {
        const inherited = [
            { info: { id: 'marker', sessionID: 'ses', role: 'user' }, parts: [{ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true }] },
            { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' }, parts: [{ id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'inherited', time: { end: 1 } }] }
        ];
        const onSummary = vi.fn();
        const onFailure = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1',
            suppressInheritedCompactions: true, onSummary, onFailure, onText: vi.fn(), fetchImpl: async () => Response.json(inherited) });
        await transcript.refresh();
        expect(onSummary).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
        // Replays after the baseline applied stay published.
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' } });
        expect(onSummary).not.toHaveBeenCalled();
        transcript.event('message.updated', { info: { id: 'new-marker', sessionID: 'ses', role: 'user' } });
        transcript.event('message.part.updated', { part: { id: 'new-marker-part', messageID: 'new-marker', sessionID: 'ses', type: 'compaction', auto: true } });
        transcript.event('message.updated', { info: { id: 'new-summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'new-marker' } });
        transcript.event('message.part.updated', { part: { id: 'new-summary-part', messageID: 'new-summary', sessionID: 'ses', type: 'text', text: 'fresh', time: { end: 2 } } });
        transcript.event('message.updated', { info: { id: 'new-summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'new-marker', finish: 'stop' } });
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('new-marker', 'fresh', 'auto');
        transcript.close();
    });
    it('publishes a compaction that completes live during baseline recovery exactly once', async () => {
        // The first read fails, so the baseline never applies. A fork child's
        // own compaction then completes over the live stream: it belongs to
        // this runtime, must publish, and must not be lost to the baseline
        // suppression window.
        const persisted = [
            { info: { id: 'marker', sessionID: 'ses', role: 'user' }, parts: [{ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true }] },
            { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' }, parts: [{ id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'live summary', time: { end: 1 } }] }
        ];
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValue(Response.json(persisted));
        const onSummary = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1',
            suppressInheritedCompactions: true, onSummary, onText: vi.fn(), fetchImpl });
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'marker', sessionID: 'ses', role: 'user' } });
        transcript.event('message.part.updated', { part: { id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true } });
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker' } });
        transcript.event('message.part.updated', { part: { id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'live summary', time: { end: 1 } } });
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' } });
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'live summary', 'auto');
        transcript.close();
    });
    it('publishes a compaction failure that surfaces live during baseline recovery exactly once', async () => {
        const persisted = [
            { info: { id: 'marker', sessionID: 'ses', role: 'user' }, parts: [{ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true }] },
            { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', error: true, finish: 'stop' }, parts: [] }
        ];
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValue(Response.json(persisted));
        const onSummary = vi.fn();
        const onFailure = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1',
            suppressInheritedCompactions: true, onSummary, onFailure, onText: vi.fn(), fetchImpl });
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'marker', sessionID: 'ses', role: 'user' } });
        transcript.event('message.part.updated', { part: { id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true } });
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', error: true, finish: 'stop' } });
        expect(onFailure).toHaveBeenCalledExactlyOnceWith('marker', 'auto');
        await transcript.refresh();
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onSummary).not.toHaveBeenCalled();
        transcript.close();
    });
    it('still suppresses an inherited compaction that only the baseline snapshot reports', async () => {
        const inherited = [
            { info: { id: 'marker', sessionID: 'ses', role: 'user' }, parts: [{ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true }] },
            { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' }, parts: [{ id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'inherited summary', time: { end: 1 } }] }
        ];
        const fetchImpl = vi.fn().mockResolvedValue(Response.json(inherited));
        const onSummary = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1',
            suppressInheritedCompactions: true, onSummary, onText: vi.fn(), fetchImpl });
        await transcript.refresh();
        expect(onSummary).not.toHaveBeenCalled();
        await transcript.refresh();
        expect(onSummary).not.toHaveBeenCalled();
        transcript.close();
    });
    it('does not double publish a live compaction when the baseline recovers with the same row', async () => {
        const persisted = [
            { info: { id: 'marker', sessionID: 'ses', role: 'user' }, parts: [{ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true }] },
            { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' }, parts: [{ id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'live summary', time: { end: 1 } }] }
        ];
        const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValue(Response.json(persisted));
        const onSummary = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v1',
            suppressInheritedCompactions: true, onSummary, onText: vi.fn(), fetchImpl });
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'marker', sessionID: 'ses', role: 'user' } });
        transcript.event('message.part.updated', { part: { id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true } });
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker' } });
        transcript.event('message.part.updated', { part: { id: 'summary-part', messageID: 'summary', sessionID: 'ses', type: 'text', text: 'live summary', time: { end: 1 } } });
        transcript.event('message.updated', { info: { id: 'summary', sessionID: 'ses', role: 'assistant', summary: true, parentID: 'marker', finish: 'stop' } });
        // The recovered baseline holds the same completed row; the live
        // publication must already have marked it.
        await transcript.refresh();
        await transcript.refresh();
        expect(onSummary).toHaveBeenCalledTimes(1);
        transcript.close();
    });
    it('drops a stale read and honors an idle/reconnect refresh requested while it was in flight', async () => {
        let resolve!: (r: Response) => void;
        const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockResolvedValue(Response.json([]));
        const { transcript, onText } = setup(fetchImpl);
        const first = transcript.refresh();
        transcript.event('message.updated', { info: { id: 'answer', sessionID: 'ses', role: 'assistant' } });
        transcript.event('message.part.updated', { part: { id: 'part', sessionID: 'ses', messageID: 'answer', type: 'text', text: 'new' } });
        void transcript.refresh();
        resolve(Response.json([{ info: { id: 'answer', sessionID: 'ses', role: 'assistant' }, parts: [{ id: 'part', sessionID: 'ses', messageID: 'answer', type: 'text', text: 'stale' }] }]));
        await first;
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'new' }));
        transcript.close();
    });
    it('scopes v2 records from the session read route and ignores explicitly foreign entries', async () => {
        const onSummary = vi.fn();
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', headers: { authorization: 'synthetic' }, onText: vi.fn(), onSummary,
            fetchImpl: vi.fn(async () => Response.json({ data: [
                { id: 'auto', type: 'compaction', status: 'completed', reason: 'auto', summary: 'Native summary' },
                { id: 'child', sessionID: 'child', type: 'compaction', status: 'completed', summary: 'Foreign' }
            ] })) });
        await transcript.refresh();
        await transcript.refresh();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('auto', 'Native summary', 'auto');
        transcript.close();
    });
    it('reports read failure once, retries, and suppresses late data after cleanup', async () => {
        const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
        const { transcript, onSummary, onReadFailure } = setup(fetchImpl);
        await transcript.refresh(); await transcript.refresh();
        expect(onReadFailure).toHaveBeenCalledOnce();
        transcript.close();
        await transcript.refresh();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(onSummary).not.toHaveBeenCalled();
    });
    it('reads every v2 compaction page in chronological order before projection', async () => {
        const onSummary = vi.fn();
        const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'old', type: 'compaction', status: 'completed', reason: 'auto', summary: 'old' }], cursor: { next: 'opaque' } }))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'new', type: 'compaction', status: 'completed', reason: 'auto', summary: 'new' }], cursor: { next: null } }));
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', fetchImpl, onText: vi.fn(), onSummary });
        await transcript.refresh();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][0]).toContain('type=compaction');
        expect(fetchImpl.mock.calls[0][0]).toContain('order=asc');
        expect(fetchImpl.mock.calls[1][0]).toContain('cursor=opaque');
        expect(fetchImpl.mock.calls[1][0]).not.toContain('order=');
        expect(onSummary.mock.calls.map(c => c[0])).toEqual(['old', 'new']);
        transcript.close();
    });
    it('bounds cumulative stream emissions and always delivers the final snapshot', async () => {
        vi.useFakeTimers();
        const { transcript, onText } = setup();
        await transcript.refresh();
        transcript.event('message.updated', { info: { id: 'answer', sessionID: 'ses', role: 'assistant' } });
        for (let i = 1; i <= 100; i++) transcript.event('message.part.updated', { part: { id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'x'.repeat(i) } });
        expect(onText).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120);
        expect(onText).toHaveBeenCalledTimes(2);
        transcript.event('message.part.updated', { part: { id: 'part', messageID: 'answer', sessionID: 'ses', type: 'text', text: 'Final', time: { end: 1 } } });
        expect(onText).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Final', complete: true }));
        transcript.close();
        await vi.runAllTimersAsync();
        expect(onText).toHaveBeenCalledTimes(3);
    });

});


describe('v2 durable application start', () => {
    it('keeps the start identity across fast completion and running snapshot replay without observing preparation usage', async () => {
        const onStart = vi.fn(), onSummary = vi.fn();
        const fetchImpl = vi.fn(async () => Response.json({ data: [{ id: 'msg_apply', type: 'compaction', status: 'completed', reason: 'auto', summary: 'Installed summary' }] }));
        const transcript = new OpencodeNativeTranscript({ baseUrl: 'http://127.0.0.1:1', sessionId: 'ses', directory: '/project', mode: 'v2', fetchImpl, onText: vi.fn(), onStart, onSummary });
        transcript.event('session.usage.recorded', { sessionID: 'ses', source: 'compaction', tokens: { input: 100, output: 20 } }, 'evt_prepare_usage');
        transcript.event('session.compaction.started', { sessionID: 'other', reason: 'auto' }, 'evt_foreign');
        expect(onStart).not.toHaveBeenCalled();
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_apply');
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_apply');
        await transcript.refresh();
        expect(onStart).toHaveBeenCalledExactlyOnceWith('msg_apply', 'auto');
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('msg_apply', 'Installed summary', 'auto');
        transcript.close();
        transcript.event('session.compaction.started', { sessionID: 'ses', reason: 'auto' }, 'evt_late');
        expect(onStart).toHaveBeenCalledTimes(1);
    });
});
