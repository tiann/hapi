import { z } from 'zod';
import type { ApiSessionClient } from '@/api/apiSession';
import { record, string } from './gateway';

const QuestionsSchema = z.array(z.object({ title: z.string().min(1), options: z.array(z.string()).nullish() })).min(1);
const ReplySchema = z.object({
    id: z.string(), approved: z.boolean(),
    answers: z.union([z.record(z.string(), z.array(z.string())), z.record(z.string(), z.object({ answers: z.array(z.string()) }))]).optional()
});
type Question = { id: string; question: string; options: Array<{ label: string; description: string }>; isOther: boolean };
type Pending = { id: string; questions: Question[]; submitted: boolean; answers?: z.infer<typeof ReplySchema>['answers'] };

/** Async questions are assistant items. Answers are user messages, not JSON-RPC responses. */
export class SharedCodexAsyncQuestions {
    private readonly pending = new Map<string, Pending>();
    private readonly retired = new Set<string>();

    constructor(private readonly session: ApiSessionClient, private readonly submit: (id: string, text: string) => Promise<void>) {}

    notification(method: string, params: unknown): void {
        const p = record(params);
        const item = record(p.item);
        if ((method === 'item/started' || method === 'item/completed') && item.type === 'userMessage') {
            for (const request of this.pending.values()) {
                const ownAnswer = item.clientId === `${request.id}:answer` || item.clientUserMessageId === `${request.id}:answer`;
                this.finish(request, ownAnswer ? 'approved' : 'resolved', ownAnswer ? request.answers : undefined);
            }
        }
        if (method === 'item/completed') this.receive(string(p.threadId) ?? '', item);
    }

    restore(threadId: string, thread: Record<string, unknown>): void {
        const unanswered: Record<string, unknown>[] = [];
        for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
            for (const raw of Array.isArray(record(turn).items) ? record(turn).items as unknown[] : []) {
                const item = record(raw);
                if (item.type === 'userMessage') unanswered.length = 0;
                else if (item.type === 'agentMessage' && Array.isArray(item.questions) && item.questions.length) unanswered.push(item);
            }
        }
        const currentIds = new Set(unanswered.map(item => `codex-async:${threadId}:${item.id}`));
        // The wrapper can restart after another native client has answered.
        for (const id of Object.keys(this.session.getAgentState()?.requests ?? {})) {
            if (id.startsWith(`codex-async:${threadId}:`) && !currentIds.has(id) && !this.pending.has(id)) {
                this.pending.set(id, { id, questions: [], submitted: false });
            }
        }
        for (const request of this.pending.values()) {
            if (!currentIds.has(request.id) && !request.submitted) this.finish(request, 'resolved');
        }
        for (const item of unanswered) this.receive(threadId, item);
    }

    private receive(threadId: string, item: Record<string, unknown>): void {
        if (item.type !== 'agentMessage' || !threadId || !string(item.id)) return;
        const parsed = QuestionsSchema.safeParse(item.questions);
        if (!parsed.success) return;
        const id = `codex-async:${threadId}:${item.id}`;
        if (this.pending.has(id) || this.retired.has(id) || this.session.getAgentState()?.completedRequests?.[id]) return;
        const questions = parsed.data.map((question, index) => ({
            id: String(index), question: question.title, isOther: true,
            options: (question.options ?? []).map(label => ({ label, description: '' }))
        }));
        this.pending.set(id, { id, questions, submitted: false });
        const input = { questions, isAsync: true, isBlocking: false };
        this.session.sendAgentMessage({ type: 'tool-call', name: 'request_user_input', callId: id, input, id: `${id}:start` }, `${id}:start`);
        this.session.updateAgentState(state => ({ ...state, requests: { ...state.requests,
            [id]: { tool: 'request_user_input', toolCallId: id, arguments: input, createdAt: state.requests?.[id]?.createdAt ?? Date.now() }
        } }));
    }

    async reply(raw: unknown): Promise<boolean> {
        const id = string(record(raw).id);
        if (!id?.startsWith('codex-async:')) return false;
        const reply = ReplySchema.parse(raw);
        const request = this.pending.get(id);
        if (!request || request.submitted) throw new Error('Question already answered or submitted');
        if (!reply.approved) { this.finish(request, 'canceled'); return true; }
        const lines = request.questions.map(question => {
            const value = reply.answers?.[question.id];
            const answers = (Array.isArray(value) ? value : value?.answers ?? [])
                .map(answer => answer.replace(/^user_note: /, '').trim()).filter(Boolean);
            if (!answers.length) throw new Error(`Missing answer: ${question.question}`);
            return `${question.question}\n${answers.join('\n')}`;
        });
        request.submitted = true;
        request.answers = reply.answers;
        try {
            // Stable client id makes a retry after an uncertain delivery idempotent.
            await this.submit(`${id}:answer`, lines.join('\n\n'));
            this.finish(request, 'approved', reply.answers);
        } catch (error) {
            request.submitted = false;
            throw error;
        }
        return true;
    }

    private finish(request: Pending, status: 'approved' | 'resolved' | 'canceled', answers?: z.infer<typeof ReplySchema>['answers']): void {
        if (!this.pending.delete(request.id)) return;
        this.retired.add(request.id);
        this.session.sendAgentMessage({ type: 'tool-call-result', callId: request.id, output: { status, answers }, id: `${request.id}:result` }, `${request.id}:result`);
        this.session.updateAgentState(state => {
            const requests = { ...state.requests };
            const prior = requests[request.id];
            delete requests[request.id];
            return { ...state, requests, completedRequests: { ...state.completedRequests,
                ...(prior ? { [request.id]: { ...prior, status, answers, completedAt: Date.now() } } : {})
            } };
        });
    }
}
