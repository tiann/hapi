import { describe, expect, it } from 'vitest';
import {
    agyQuestionContent,
    parseAgyQuestionForm,
    questionCardInput,
    questionCardInputFromToolCall
} from './agyQuestion';

// Recorded from agy 1.5.3 (`elicitation/create` after `ask_question`).
const singleChoice = {
    sessionId: 'agy-conv-1',
    toolCallId: 'call_1',
    mode: 'form',
    message: 'The agent has a question.',
    requestedSchema: {
        type: 'object',
        properties: {
            q1: {
                type: 'string',
                title: 'Do you prefer RED or BLUE?',
                oneOf: [{ const: '1', title: '(Recommended) RED' }, { const: '2', title: 'BLUE' }]
            },
            q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer to: Do you prefer RED or BLUE?' }
        }
    }
};

const twoQuestions = {
    sessionId: 'agy-conv-1',
    toolCallId: 'call_2',
    mode: 'form',
    message: 'The agent has 2 questions.',
    requestedSchema: {
        type: 'object',
        properties: {
            q1: {
                type: 'array',
                title: 'Which colors do you like?',
                items: { anyOf: [{ const: '1', title: 'RED' }, { const: '2', title: 'GREEN' }, { const: '3', title: 'BLUE' }] }
            },
            q1_other: { type: 'string', title: 'Other' },
            q2: { type: 'string', title: 'Light or dark theme?', oneOf: [{ const: '1', title: 'LIGHT' }, { const: '2', title: 'DARK' }] },
            q2_other: { type: 'string', title: 'Other' }
        }
    }
};

describe('agy question form', () => {
    it('reads a single-choice question and shows it as the question card', () => {
        const form = parseAgyQuestionForm(singleChoice)!;
        expect(form).toEqual({
            toolCallId: 'call_1',
            questions: [{
                key: 'q1',
                otherKey: 'q1_other',
                question: 'Do you prefer RED or BLUE?',
                choices: [{ value: '1', label: '(Recommended) RED' }, { value: '2', label: 'BLUE' }],
                multiSelect: false
            }]
        });
        expect(questionCardInput(form.questions)).toEqual({
            questions: [{
                question: 'Do you prefer RED or BLUE?',
                header: null,
                options: [{ label: '(Recommended) RED', description: null }, { label: 'BLUE', description: null }],
                multiSelect: false,
                allowFreeText: true
            }]
        });
    });

    it('marks the card as not allowing free text when the form has no qN_other', () => {
        const params = structuredClone(singleChoice) as any;
        delete params.requestedSchema.properties.q1_other;
        const form = parseAgyQuestionForm(params)!;

        expect(questionCardInput(form.questions).questions[0]?.allowFreeText).toBe(false);
    });

    it('reads several questions in order, with multi-select', () => {
        const form = parseAgyQuestionForm(twoQuestions)!;
        expect(form.questions.map((question) => [question.key, question.multiSelect, question.choices.length]))
            .toEqual([['q1', true, 3], ['q2', false, 2]]);
    });

    it('ignores elicitations that are not agy questions', () => {
        expect(parseAgyQuestionForm({ mode: 'url', url: 'https://example.com' })).toBeNull();
        expect(parseAgyQuestionForm({ mode: 'form', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } })).toBeNull();
        expect(parseAgyQuestionForm(null)).toBeNull();
    });

    it('answers with the chosen option value only, so agy records the bare label', () => {
        const form = parseAgyQuestionForm(singleChoice)!;
        // An approval hook reads agy's "A1: <label>" and matches it exactly.
        expect(agyQuestionContent(form.questions, { '0': ['BLUE'] })).toEqual({ q1: '2' });
        expect(agyQuestionContent(form.questions, { '0': ['(Recommended) RED'] })).toEqual({ q1: '1' });
        expect(agyQuestionContent(form.questions, { '0': ['BLUE', '  '] })).toEqual({ q1: '2' });
    });

    it('sends typed text as the free-form answer', () => {
        const form = parseAgyQuestionForm(singleChoice)!;
        expect(agyQuestionContent(form.questions, { '0': ['GREEN please'] })).toEqual({ q1_other: 'GREEN please' });
        expect(agyQuestionContent(form.questions, { '0': ['BLUE', 'and a bit of RED'] })).toEqual({ q1: '2', q1_other: 'and a bit of RED' });
    });

    it('answers multi-select and several questions by index', () => {
        const form = parseAgyQuestionForm(twoQuestions)!;
        expect(agyQuestionContent(form.questions, { '0': ['GREEN', 'BLUE'], '1': ['DARK'] }))
            .toEqual({ q1: ['2', '3'], q2: '2' });
        expect(agyQuestionContent(form.questions, undefined)).toEqual({});
    });

    it('matches labels without surrounding spaces, and by position when the card showed other labels', () => {
        const form = parseAgyQuestionForm({
            ...singleChoice,
            requestedSchema: { type: 'object', properties: {
                q1: { type: 'string', title: 'Pick', oneOf: [{ const: '1', title: 'RED ' }, { const: '2', title: 'Blue' }] },
                q1_other: { type: 'string', title: 'Other' }
            } }
        })!;
        expect(agyQuestionContent(form.questions, { '0': ['RED'] })).toEqual({ q1: '1' });
        expect(agyQuestionContent(form.questions, { '0': ['BLUE'] }, [['RED', 'BLUE']])).toEqual({ q1: '2' });
        // Not by position when the card showed a different set of options.
        expect(agyQuestionContent(form.questions, { '0': ['BLUE'] }, [['GREEN', 'BLUE', 'RED']])).toEqual({ q1_other: 'BLUE' });
    });

    it('accepts answers in the nested { answers } shape too', () => {
        const form = parseAgyQuestionForm(singleChoice)!;
        expect(agyQuestionContent(form.questions, { '0': { answers: ['BLUE'] } })).toEqual({ q1: '2' });
        expect(agyQuestionContent(form.questions, { '0': 'BLUE' })).toEqual({});
    });

    it('shows the ask_question tool call as the same card, from an array or a JSON string', () => {
        const questions = [{ is_multi_select: true, options: ['RED', 'BLUE'], question: 'Colors?' }];
        const expected = {
            questions: [{
                question: 'Colors?',
                header: null,
                options: [{ label: 'RED', description: null }, { label: 'BLUE', description: null }],
                multiSelect: true
            }]
        };
        expect(questionCardInputFromToolCall({ questions })).toEqual(expected);
        expect(questionCardInputFromToolCall({ questions: JSON.stringify(questions) })).toEqual(expected);
        expect(questionCardInputFromToolCall({ questions: 'not json' })).toBeNull();
        expect(questionCardInputFromToolCall(undefined)).toBeNull();
    });
});
