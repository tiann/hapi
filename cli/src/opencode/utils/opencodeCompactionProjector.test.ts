import { describe, expect, it, vi } from 'vitest';
import { OpencodeCompactionProjector } from './opencodeCompactionProjector';

const marker = { id: 'marker', sessionID: 'ses', role: 'user' };
const summary = { id: 'summary', sessionID: 'ses', role: 'assistant', parentID: 'marker', summary: true, finish: 'stop' };
const text = { id: 'part', sessionID: 'ses', messageID: 'summary', type: 'text', text: 'Checkpoint', time: { end: 1 } };
function setup() {
    const onSummary = vi.fn();
    const onText = vi.fn();
    return { onSummary, onText, projector: new OpencodeCompactionProjector({ sessionId: 'ses', onSummary, onText }) };
}
describe('OpenCode native compaction projection', () => {
    it('holds summary text, validates its parent, and emits one stable card across replay', () => {
        const { projector, onSummary, onText } = setup();
        projector.message(summary);
        projector.part(text);
        expect(onSummary).not.toHaveBeenCalled();
        expect(onText).not.toHaveBeenCalled();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true });
        projector.part(text);
        projector.message(summary);
        projector.flush();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'Checkpoint', 'auto');
    });
    it.each([
        { state: 'incomplete', info: { ...summary, finish: undefined } },
        { state: 'failed', info: { ...summary, error: { message: 'failed' } } },
        { state: 'foreign', info: { ...summary, sessionID: 'child' } },
        { state: 'unlinked', info: { ...summary, parentID: 'other' } }
    ])('does not turn an $state summary into success', ({ info }) => {
        const { projector, onSummary } = setup();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: true });
        projector.message(info);
        projector.part(text);
        projector.flush();
        expect(onSummary).not.toHaveBeenCalled();
    });
    it('preserves identical real prompts and unrelated synthetic text, hiding only native continuation metadata', () => {
        const { projector, onText } = setup();
        projector.message({ id: 'u', sessionID: 'ses', role: 'user' });
        for (const [id, extra] of [['real', {}], ['synthetic', { synthetic: true }], ['control', { synthetic: true, metadata: { compaction_continue: true } }]] as const) {
            projector.part({ id, messageID: 'u', sessionID: 'ses', type: 'text', text: 'Continue if you have next steps', ...extra });
        }
        expect(onText.mock.calls.map(c => c[0].id)).toEqual(['real', 'synthetic']);
    });
    it('holds parts arriving before metadata and preserves the real response after compaction', () => {
        const { projector, onText } = setup();
        projector.part({ ...text, messageID: 'answer', id: 'answer-part', text: 'Next answer' });
        expect(onText).not.toHaveBeenCalled();
        projector.message({ id: 'answer', sessionID: 'ses', role: 'assistant' });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Next answer', role: 'assistant' }));
    });
    it('accepts v2 completed checkpoints, including opaque windows and factless completed status', () => {
        const { projector, onSummary } = setup();
        projector.message({ id: 'v2', sessionID: 'ses', type: 'compaction', status: 'running', summary: 'partial' });
        projector.message({ id: 'failed', sessionID: 'ses', type: 'compaction', status: 'failed', summary: 'partial' });
        projector.message({ id: 'empty', sessionID: 'ses', type: 'compaction', status: 'completed', summary: '' });
        projector.message({ id: 'v2', sessionID: 'ses', type: 'compaction', status: 'completed', summary: 'Done' });
        projector.message({ id: 'native', sessionID: 'ses', type: 'compaction', status: 'completed', summary: '', native: { messages: [{ role: 'user', content: 'input' }] } });
        projector.flush();
        expect(onSummary.mock.calls).toEqual([['v2', 'Done', undefined], ['empty', '', undefined], ['native', '', undefined]]);
    });
    it('keeps visible synthetic assistant output without an end time and honors ignored metadata', () => {
        const { projector, onText } = setup();
        projector.message({ id: 'answer', sessionID: 'ses', role: 'assistant' });
        projector.part({ ...text, id: 'visible', messageID: 'answer', synthetic: true, time: undefined });
        projector.part({ ...text, id: 'ignored', messageID: 'answer', ignored: true });
        expect(onText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'visible', complete: true }));
    });
    it('settles a complete multipart summary once at the storage scan boundary', () => {
        const { projector, onSummary } = setup();
        projector.message(marker);
        projector.part({ id: 'marker-part', messageID: 'marker', sessionID: 'ses', type: 'compaction', auto: false });
        projector.message(summary);
        projector.part({ ...text, text: 'First' });
        projector.part({ ...text, id: 'part-2', text: 'Second' });
        expect(onSummary).not.toHaveBeenCalled();
        projector.flush();
        projector.flush();
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('marker', 'First\n\nSecond', 'manual');
    });

    it('retains a failed summary until its missed automatic marker is classified', () => {
        const onFailure = vi.fn();
        const projector = new OpencodeCompactionProjector({ sessionId: 'ses', onSummary: vi.fn(), onFailure });
        projector.message({ ...summary, error: { message: 'failed' } });
        projector.flush();
        expect(onFailure).not.toHaveBeenCalled();
        projector.message(marker);
        projector.part({ id: 'marker-part', sessionID: 'ses', messageID: 'marker', type: 'compaction', auto: true });
        projector.flush();
        projector.flush();
        expect(onFailure).toHaveBeenCalledExactlyOnceWith('marker', 'auto');
    });

});


describe('v2 background application boundary', () => {
    it('starts only a native running application, ignores usage as context, and deduplicates terminal replay', () => {
        const onStart = vi.fn(), onSummary = vi.fn(), onFailure = vi.fn();
        const projector = new OpencodeCompactionProjector({ sessionId: 'ses', onStart, onSummary, onFailure });
        projector.message({ id: 'answer', sessionID: 'ses', type: 'assistant', tokens: { input: 156000, output: 20 } });
        projector.flush();
        expect(onStart).not.toHaveBeenCalled(); expect(onSummary).not.toHaveBeenCalled();
        projector.snapshot([{ id: 'apply', sessionID: 'other', type: 'compaction', status: 'running', reason: 'auto', summary: '' }]);
        expect(onStart).not.toHaveBeenCalled();
        projector.snapshot([{ id: 'apply', sessionID: 'ses', type: 'compaction', status: 'running', reason: 'auto', summary: '' }]);
        projector.start('apply', 'auto');
        expect(onStart).toHaveBeenCalledExactlyOnceWith('apply', 'auto');
        projector.snapshot([{ id: 'apply', sessionID: 'ses', type: 'compaction', status: 'completed', reason: 'auto', summary: '', tokens: { input: 100, output: 20 } }]);
        projector.snapshot([{ id: 'apply', sessionID: 'ses', type: 'compaction', status: 'running', reason: 'auto', summary: '' }]);
        projector.start('apply', 'auto');
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('apply', '', 'auto');
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(onFailure).not.toHaveBeenCalled();
    });
});


describe('v2 terminal application ordering', () => {
    it('never reopens a failed application or publishes a delayed opposite terminal outcome', () => {
        const onStart = vi.fn(), onSummary = vi.fn(), onFailure = vi.fn();
        const projector = new OpencodeCompactionProjector({ sessionId: 'ses', onStart, onSummary, onFailure });
        const row = { id: 'apply', sessionID: 'ses', type: 'compaction', reason: 'auto' };
        projector.snapshot([{ ...row, status: 'failed', error: { type: 'compaction.interrupted' } }]);
        projector.start('apply', 'auto');
        projector.snapshot([{ ...row, status: 'running', summary: '' }]);
        projector.snapshot([{ ...row, status: 'completed', summary: 'stale summary' }]);
        expect(onFailure).toHaveBeenCalledExactlyOnceWith('apply', 'auto');
        expect(onStart).not.toHaveBeenCalled(); expect(onSummary).not.toHaveBeenCalled();
        projector.snapshot([{ ...row, id: 'next', status: 'completed', summary: 'new application' }]);
        projector.snapshot([{ ...row, id: 'next', status: 'failed' }]);
        expect(onSummary).toHaveBeenCalledExactlyOnceWith('next', 'new application', 'auto');
        expect(onFailure).toHaveBeenCalledTimes(1);
    });
});
