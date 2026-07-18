import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler, buildAskUserQuestionUpdatedInput } from './permissionHandler';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '../sdk/prompts';
import type { Session } from '../session';

function createFakeSession() {
    const queueItems: { message: string; mode: unknown }[] = [];

    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn(),
        },
        queue: {
            unshift: vi.fn((message: string, mode: unknown) => {
                queueItems.push({ message, mode });
            }),
        },
        setPermissionMode: vi.fn(),
    } as unknown as Session;

    return { session, queueItems };
}

describe('PermissionHandler — YOLO plan mode', () => {
    it('injects PLAN_FAKE_RESTART and denies exit_plan_mode in bypassPermissions', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        // Simulate Claude emitting an assistant message with exit_plan_mode tool_use
        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-1', name: 'exit_plan_mode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'exit_plan_mode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        // Should deny with PLAN_FAKE_REJECT (so Claude restarts)
        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });

        // Should inject PLAN_FAKE_RESTART into the queue
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
        expect(queueItems[0].mode).toEqual({ permissionMode: 'bypassPermissions' });
    });

    it('injects PLAN_FAKE_RESTART for ExitPlanMode variant', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-2', name: 'ExitPlanMode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'ExitPlanMode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
    });

    it('allows normal tools in bypassPermissions without queue injection', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
        expect(queueItems).toHaveLength(0);
    });
});

describe('buildAskUserQuestionUpdatedInput — Claude Code answer contract', () => {
    // Claude Code (v2.1.x) AskUserQuestion reads `input.answers` to build the tool
    // result the model sees. Its contract (per sdk-tools.d.ts) is:
    //   answers: { [questionText: string]: string }   // value = single string; multi-select comma-joined
    // HAPI's internal wire format is { [index]: string[] }, which produces an EMPTY
    // answer in the tool result ("...have been answered: ."), so the model never sees
    // the user's selection. This function must translate index/array -> text/string.
    const makeInput = (questions: { question: string; multiSelect?: boolean }[]) => ({
        questions: questions.map((q) => ({
            question: q.question,
            header: q.question.slice(0, 10),
            options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
            ],
            multiSelect: q.multiSelect ?? false,
        })),
    });

    it('keys answers by question TEXT (not index) with STRING values (not arrays)', () => {
        const input = makeInput([{ question: 'What is your favorite color?' }]);
        const updated = buildAskUserQuestionUpdatedInput(input, { '0': ['Red'] });

        expect(updated.answers).toEqual({ 'What is your favorite color?': 'Red' });
        // value must be a plain string, never an array
        expect(typeof (updated.answers as Record<string, unknown>)['What is your favorite color?']).toBe('string');
        // original questions are preserved
        expect((updated as { questions: unknown }).questions).toEqual(input.questions);
    });

    it('comma-joins multi-select answers into a single string', () => {
        const input = makeInput([{ question: 'Pick features?', multiSelect: true }]);
        const updated = buildAskUserQuestionUpdatedInput(input, { '0': ['Auth', 'Billing', 'Search'] });

        expect(updated.answers).toEqual({ 'Pick features?': 'Auth, Billing, Search' });
    });

    it('maps multiple questions to their respective texts', () => {
        const input = makeInput([{ question: 'First question?' }, { question: 'Second question?' }]);
        const updated = buildAskUserQuestionUpdatedInput(input, { '0': ['Yes'], '1': ['No'] });

        expect(updated.answers).toEqual({ 'First question?': 'Yes', 'Second question?': 'No' });
    });

    it('accepts the nested { answers: [...] } wire format too', () => {
        const input = makeInput([{ question: 'Nested?' }]);
        const updated = buildAskUserQuestionUpdatedInput(input, { '0': { answers: ['Picked'] } });

        expect(updated.answers).toEqual({ 'Nested?': 'Picked' });
    });
});
