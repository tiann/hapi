import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { SharedCodexAsyncQuestions } from './asyncQuestions';

const item = { id: 'question', type: 'agentMessage', delivery: 'async', text: '', questions: [
    { title: 'Which scope?', options: ['Small', 'Full'] }, { title: 'Any constraints?', options: null }
] };
function fixture() {
    let state: AgentState = {};
    const send = vi.fn();
    const submit = vi.fn(async (_id: string, _text: string) => {});
    const questions = new SharedCodexAsyncQuestions({
        sendAgentMessage: send, getAgentState: () => state,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); }
    } as unknown as ApiSessionClient, submit);
    const receive = () => questions.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
    return { questions, submit, send, receive, state: () => state };
}
const id = 'codex-async:thread:question';
const answers = { '0': { answers: ['Small'] }, '1': { answers: ['user_note: No new dependencies'] } };

describe('Codex async questions', () => {
    it('renders question-only messages once, accepts a choice and free text as a steering message', async () => {
        const f = fixture(); f.receive(); f.receive();
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(f.state().requests?.[id]).toMatchObject({ tool: 'request_user_input', arguments: {
            questions: [{ id: '0', question: 'Which scope?', isOther: true }, { id: '1', question: 'Any constraints?', options: [] }]
        } });
        await f.questions.reply({ id, approved: true, answers });
        expect(f.submit).toHaveBeenCalledWith(`${id}:answer`, 'Which scope?\nSmall\n\nAny constraints?\nNo new dependencies');
        expect(f.state().requests).toEqual({});
        expect(f.state().completedRequests?.[id]).toMatchObject({ status: 'approved', answers });
        f.receive(); expect(f.send).toHaveBeenCalledTimes(2);
    });
    it('keeps missing and failed answers pending, uses the same delivery id on retry', async () => {
        const f = fixture(); f.receive();
        await expect(f.questions.reply({ id, approved: true, answers: {} })).rejects.toThrow('Missing answer');
        f.submit.mockRejectedValueOnce(new Error('uncertain'));
        await expect(f.questions.reply({ id, approved: true, answers })).rejects.toThrow('uncertain');
        expect(f.state().requests?.[id]).toBeDefined();
        await f.questions.reply({ id, approved: true, answers });
        expect(f.submit.mock.calls.map(call => call[0])).toEqual([`${id}:answer`, `${id}:answer`]);
    });
    it('dismisses without interrupting the model and rejects double submissions', async () => {
        const f = fixture(); f.receive();
        await f.questions.reply({ id, approved: false });
        expect(f.submit).not.toHaveBeenCalled();
        await expect(f.questions.reply({ id, approved: true, answers })).rejects.toThrow('already answered');
    });
    it('does not resurrect a dismissed question after replacing the wrapper', async () => {
        const f = fixture(); f.receive(); await f.questions.reply({ id, approved: false });
        const replacement = new SharedCodexAsyncQuestions({ getAgentState: f.state, sendAgentMessage: f.send } as unknown as ApiSessionClient, f.submit);
        replacement.restore('thread', { turns: [{ items: [item] }] });
        expect(f.send).toHaveBeenCalledTimes(2);
    });
    it('closes a persisted question answered natively while the wrapper was offline', () => {
        const f = fixture(); f.receive();
        let state = f.state();
        const replacement = new SharedCodexAsyncQuestions({ getAgentState: () => state, sendAgentMessage: f.send,
            updateAgentState: (fn: (value: AgentState) => AgentState) => { state = fn(state); }
        } as unknown as ApiSessionClient, f.submit);
        replacement.restore('thread', { turns: [{ items: [item, { type: 'userMessage' }] }] });
        expect(state.requests).toEqual({});
        expect(state.completedRequests?.[id].status).toBe('resolved');
    });
    it('restores only questions after the last native user reply', () => {
        const f = fixture();
        f.questions.restore('thread', { turns: [{ items: [item, { type: 'userMessage' }, { ...item, id: 'new' }] }] });
        expect(Object.keys(f.state().requests ?? {})).toEqual(['codex-async:thread:new']);
        f.questions.notification('item/started', { item: { type: 'userMessage' } });
        expect(f.state().requests).toEqual({});
    });
});
