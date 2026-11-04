import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { INDETERMINATE_SYMBOL } from '../codexAppServerClient';
import { asyncQuestionsForItem, SharedCodexAsyncQuestions } from './asyncQuestions';

const item = { type: 'agentMessage', id: 'call_async', delivery: 'async', text: 'Which client?\n- Web\n- Terminal',
    questions: [{ title: 'Which client?', options: ['Web', 'Terminal'] }, { title: 'Any details?', options: null }] };
const questions = asyncQuestionsForItem('thread', item);
function nativeReply(questionItemId: string, answer: string) {
    return { type: 'userMessage', content: [{ type: 'text', text:
        `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId, answer, question: 'Which client?' }])}\n</send_user_message_question_reply>` }] };
}
function fixture() {
    let state: AgentState = {};
    const send = vi.fn();
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); }
    } as unknown as ApiSessionClient;
    const submit = vi.fn(async (_threadId: string, _text: string, _id: string) => {});
    const manager = new SharedCodexAsyncQuestions(session, submit);
    return { manager, send, submit, state: () => state };
}

describe('Codex queued follow-up questions', () => {
    it('preserves per-question native IDs and options in the existing question contract', () => {
        const f = fixture(); f.manager.observeItem('thread', item); f.manager.observeItem('thread', item);
        expect(Object.values(f.state().requests!)).toHaveLength(2);
        expect(questions[0].questionItemId).toBe('["request_user_input_async","call_async",0]');
        expect(f.state().requests![questions[0].id]).toMatchObject({ tool: 'request_user_input', arguments: {
            isBlocking: false, questions: [{ id: questions[0].questionItemId, question: 'Which client?', isOther: true,
                options: [{ label: 'Web', description: '' }, { label: 'Terminal', description: '' }] }]
        } });
        expect(f.state().requests![questions[1].id].arguments).toMatchObject({ questions: [{ options: [] }] });
    });

    it.each([['Web'], ['None of the above', 'user_note: Mobile']])('submits %j as native user input and waits for consumption', async (...values) => {
        const f = fixture(); f.manager.observeItem('thread', item);
        const q = questions[0];
        const reply = { id: q.id, approved: true, answers: { [q.questionItemId]: { answers: values } } };
        await f.manager.answer(reply);
        const answer = values.at(-1)!.replace(/^user_note: /, '');
        expect(f.submit).toHaveBeenCalledWith('thread',
            `<send_user_message_question_reply>\n${JSON.stringify([{ answer, question: q.title, questionItemId: q.questionItemId }])}\n</send_user_message_question_reply>`, `${q.id}:answer`);
        expect(f.state().requests![q.id]).toBeDefined();
        expect(f.state().completedRequests?.[q.id]).toBeUndefined();
        await expect(f.manager.answer(reply)).rejects.toThrow('already submitted');
        f.manager.observeItem('thread', nativeReply(q.questionItemId, answer));
        expect(f.state().requests![q.id]).toBeUndefined();
        expect(f.state().completedRequests![q.id]).toMatchObject({ status: 'resolved', answers: {
            [q.questionItemId]: { answers: [values.at(-1)] }
        } });
        expect(f.state().requests![questions[1].id]).toBeDefined();
    });

    it('rejects missing/empty answers without submitting and allows a corrected answer', async () => {
        const f = fixture(); f.manager.observeItem('thread', item); const q = questions[1];
        for (const answers of [undefined, {}, { [q.questionItemId]: ['user_note:  '] }]) {
            await expect(f.manager.answer({ id: q.id, approved: true, answers })).rejects.toThrow('answer is required');
        }
        expect(f.submit).not.toHaveBeenCalled();
        await f.manager.answer({ id: q.id, approved: true, answers: { [q.questionItemId]: ['user_note: Details'] } });
        expect(f.submit).toHaveBeenCalledOnce();
    });

    it('consumes terminal replies before replay and does not reopen answered questions', async () => {
        const f = fixture(); const q = questions[0];
        const reply = nativeReply(q.questionItemId, 'Terminal');
        f.manager.history('thread', { turns: [{ items: [item, reply] }] });
        f.manager.observeItem('thread', item);
        expect(f.state().requests![q.id]).toBeUndefined();
        expect(f.state().completedRequests![q.id].status).toBe('resolved');
        expect(await f.manager.answer({ id: q.id, approved: true, answers: { [q.questionItemId]: ['Web'] } })).toBe(false);
        expect(f.submit).not.toHaveBeenCalled();
        f.manager.observeItem('thread', item);
        expect(Object.keys(f.state().requests!)).toEqual([questions[1].id]);
        expect(f.send.mock.lastCall![0]).toMatchObject({ type: 'tool-call-result', callId: q.id, output: {
            answers: { [q.questionItemId]: { answers: ['Terminal'] } }
        } });
    });

    it('scopes child replies and cards to their own thread', async () => {
        const f = fixture(); f.manager.observeItem('child', item);
        const q = asyncQuestionsForItem('child', item)[0];
        f.manager.observeItem('thread', nativeReply(q.questionItemId, 'Web'));
        expect(f.state().requests![q.id]).toBeDefined();
        await f.manager.answer({ id: q.id, approved: true, answers: { [q.questionItemId]: ['Terminal'] } });
        expect(f.submit.mock.lastCall![0]).toBe('child');
        f.manager.observeItem('child', nativeReply(q.questionItemId, 'Terminal'));
        expect(f.send.mock.lastCall![0]).toMatchObject({ type: 'agent-run-trace', agentId: 'child',
            message: { type: 'tool-call-result', callId: q.id }, scope: { parentThreadId: 'thread' } });
    });

    it.each([false, true])('retries only definitively rejected submissions (indeterminate: %s)', async indeterminate => {
        const f = fixture(); f.manager.observeItem('thread', item); const q = questions[0];
        f.submit.mockRejectedValueOnce(Object.assign(new Error('Disconnected'), { [INDETERMINATE_SYMBOL]: indeterminate }));
        const reply = { id: q.id, approved: true, answers: { [q.questionItemId]: ['Web'] } };
        await expect(f.manager.answer(reply)).rejects.toThrow('Disconnected');
        if (indeterminate) await expect(f.manager.answer(reply)).rejects.toThrow('already submitted');
        else await f.manager.answer(reply);
        expect(f.submit).toHaveBeenCalledTimes(indeterminate ? 1 : 2);
        expect(f.state().completedRequests?.[q.id]).toBeUndefined();
    });

    it('dismisses an optional question without sending input or interrupting the turn', async () => {
        const f = fixture(); f.manager.observeItem('thread', item); const q = questions[0];
        await f.manager.answer({ id: q.id, approved: false });
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.state().completedRequests![q.id].status).toBe('canceled');
        f.manager.observeItem('thread', item);
        expect(f.state().requests![q.id]).toBeUndefined();
        f.manager.observeItem('thread', nativeReply(q.questionItemId, 'Terminal'));
        expect(f.state().completedRequests![q.id].status).toBe('resolved');
    });

    it('parses literal reply tags inside an answer and ignores quoted or malformed replies', () => {
        const f = fixture(); f.manager.observeItem('thread', item); const q = questions[1];
        for (const text of ['<send_user_message_question_reply>bad json</send_user_message_question_reply>',
            `Example: ${nativeReply(q.questionItemId, 'example').content[0].text}`]) {
            f.manager.observeItem('thread', { type: 'userMessage', content: [{ type: 'text', text }] });
        }
        expect(f.state().requests![q.id]).toBeDefined();
        const answer = 'Check </send_user_message_question_reply> escaping';
        f.manager.observeItem('thread', nativeReply(q.questionItemId, answer));
        expect(f.state().completedRequests![q.id].answers).toEqual({ [q.questionItemId]: { answers: [`user_note: ${answer}`] } });
    });

    it('withdraws controls on exit without persisting a false native result', () => {
        const f = fixture(); f.manager.observeItem('thread', item); f.manager.close();
        expect(f.state().requests).toEqual({});
        expect(f.send).not.toHaveBeenCalled();
        f.manager.observeItem('thread', item);
        expect(f.state().requests).toEqual({});
    });
});
