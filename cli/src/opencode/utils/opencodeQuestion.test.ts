import { describe, expect, it } from 'vitest';
import {
    buildQuestionContent,
    normalizeQuestionToolInput,
    parseQuestionSchema,
    toAskUserQuestionInput
} from './opencodeQuestion';

const approvalSchema = {
    type: 'object',
    properties: {
        q0: {
            type: 'string',
            title: '승인',
            description: '승인 요청 테스트: 동작 확인',
            oneOf: [
                { const: '거절', title: '거절', description: '거절합니다' },
                { const: '승인', title: '승인', description: '승인합니다' }
            ]
        },
        q0_custom: { type: 'string', title: '승인 (other)', description: 'Type your own answer' }
    },
    required: []
};

const multiSchema = {
    type: 'object',
    properties: {
        q0: {
            type: 'string',
            title: 'Runtime',
            description: 'Which runtime?',
            oneOf: [{ const: 'Bun', title: 'Bun' }, { const: 'Node', title: 'Node', description: 'Stable' }]
        },
        q0_custom: { type: 'string' },
        q1: {
            type: 'array',
            title: 'Goals',
            description: 'What matters?',
            items: { anyOf: [{ const: 'Fast', title: 'Fast label', description: 'Speed' }, { const: 'Small', title: 'Small' }] }
        },
        q1_custom: { type: 'string' }
    },
    required: []
};

describe('parseQuestionSchema', () => {
    it('maps a single select form to one question', () => {
        expect(parseQuestionSchema(approvalSchema)).toEqual([{
            key: 'q0',
            header: '승인',
            question: '승인 요청 테스트: 동작 확인',
            options: [
                { value: '거절', label: '거절', description: '거절합니다' },
                { value: '승인', label: '승인', description: '승인합니다' }
            ],
            multiple: false,
            customKey: 'q0_custom'
        }]);
    });

    it('keeps schema order and detects multiselect and missing custom partner', () => {
        const schema = structuredClone(multiSchema) as { properties: Record<string, unknown> };
        delete schema.properties.q1_custom;
        const questions = parseQuestionSchema(schema);

        expect(questions?.map((q) => [q.key, q.multiple, q.customKey])).toEqual([
            ['q0', false, 'q0_custom'],
            ['q1', true, null]
        ]);
        expect(questions?.[1]?.options[0]).toEqual({ value: 'Fast', label: 'Fast label', description: 'Speed' });
    });

    it('rejects schemas it cannot represent so the form is dismissed instead of mis-answered', () => {
        expect(parseQuestionSchema(null)).toBeNull();
        expect(parseQuestionSchema({ type: 'object', properties: {} })).toBeNull();
        expect(parseQuestionSchema({ type: 'object', properties: { q0: { type: 'number' } } })).toBeNull();
        expect(parseQuestionSchema({ type: 'object', properties: { q0: { type: 'boolean' } } })).toBeNull();
    });
});

describe('toAskUserQuestionInput', () => {
    it('produces the Claude AskUserQuestion shape the web card renders', () => {
        const questions = parseQuestionSchema(multiSchema)!;

        expect(toAskUserQuestionInput(questions)).toEqual({
            questions: [
                {
                    header: 'Runtime',
                    question: 'Which runtime?',
                    options: [{ label: 'Bun' }, { label: 'Node', description: 'Stable' }],
                    multiSelect: false,
                    allowFreeText: true
                },
                {
                    header: 'Goals',
                    question: 'What matters?',
                    options: [{ label: 'Fast label', description: 'Speed' }, { label: 'Small' }],
                    multiSelect: true,
                    allowFreeText: true
                }
            ]
        });
    });
});

describe('free-text permission', () => {
    it('passes allowFreeText=false for a form without a custom partner', () => {
        const schema = structuredClone(approvalSchema);
        delete (schema.properties as Record<string, unknown>).q0_custom;
        const input = toAskUserQuestionInput(parseQuestionSchema(schema)!);

        expect(input.questions[0]?.allowFreeText).toBe(false);
    });

    it('carries OpenCode tool-call custom=false as allowFreeText=false', () => {
        const out = normalizeQuestionToolInput({
            questions: [
                { question: 'a', options: [], custom: false },
                { question: 'b', options: [], custom: true },
                { question: 'c', options: [] }
            ]
        }) as { questions: Array<Record<string, unknown>> };

        expect(out.questions.map((q) => q.allowFreeText)).toEqual([false, true, undefined]);
        expect(out.questions.every((q) => !('custom' in q))).toBe(true);
    });
});

describe('buildQuestionContent', () => {
    it('answers a single select with the option value', () => {
        const questions = parseQuestionSchema(approvalSchema)!;

        expect(buildQuestionContent(questions, { '0': ['승인'] })).toEqual({ q0: '승인' });
    });

    it('sends the option value even when the web echoes the display label', () => {
        const questions = parseQuestionSchema(multiSchema)!;

        expect(buildQuestionContent(questions, { '0': ['Bun'], '1': ['Fast label', 'Small'] }))
            .toEqual({ q0: 'Bun', q1: ['Fast', 'Small'] });
    });

    it('routes free text to the custom key', () => {
        const questions = parseQuestionSchema(multiSchema)!;

        expect(buildQuestionContent(questions, { '0': ['Deno'], '1': ['Fast', 'My own'] }))
            .toEqual({ q0_custom: 'Deno', q1: ['Fast'], q1_custom: 'My own' });
    });

    it('accepts answers keyed by schema key', () => {
        const questions = parseQuestionSchema(approvalSchema)!;

        expect(buildQuestionContent(questions, { q0: ['거절'] })).toEqual({ q0: '거절' });
    });

    it('returns null when nothing was answered', () => {
        const questions = parseQuestionSchema(approvalSchema)!;

        expect(buildQuestionContent(questions, {})).toBeNull();
        expect(buildQuestionContent(questions, { '0': [] })).toBeNull();
        expect(buildQuestionContent(questions, { '0': ['  '] })).toBeNull();
    });

    it('drops unknown values when the schema has no custom partner', () => {
        const schema = structuredClone(approvalSchema) as { properties: Record<string, unknown> };
        delete schema.properties.q0_custom;
        const questions = parseQuestionSchema(schema)!;

        expect(buildQuestionContent(questions, { '0': ['아무거나'] })).toBeNull();
    });
});

describe('normalizeQuestionToolInput', () => {
    it('renames per-question multiple to the multiSelect key the web reads', () => {
        expect(normalizeQuestionToolInput({
            questions: [{ header: 'h', question: 'q', options: [{ label: 'a', description: 'd' }], multiple: true }]
        })).toEqual({
            questions: [{ header: 'h', question: 'q', options: [{ label: 'a', description: 'd' }], multiSelect: true }]
        });
    });

    it('passes through anything that is not a questions list', () => {
        expect(normalizeQuestionToolInput({})).toEqual({});
        expect(normalizeQuestionToolInput(null)).toBeNull();
    });
});
