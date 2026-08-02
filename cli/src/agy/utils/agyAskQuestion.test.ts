import { describe, expect, it } from 'vitest'
import { buildCanonicalAskUserQuestionInput, isAgyAskQuestionToolCall } from './agyAskQuestion'

describe('isAgyAskQuestionToolCall', () => {
    it('matches agy\'s native ask_question tool name', () => {
        expect(isAgyAskQuestionToolCall({ name: 'ask_question' })).toBe(true)
    })

    it('rejects other tool names', () => {
        expect(isAgyAskQuestionToolCall({ name: 'run_command' })).toBe(false)
        expect(isAgyAskQuestionToolCall(null)).toBe(false)
        expect(isAgyAskQuestionToolCall(undefined)).toBe(false)
    })
})

describe('buildCanonicalAskUserQuestionInput', () => {
    it('translates agy\'s native single-select shape (string options, is_multi_select) to canonical', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [
                { question: 'Which fruit do you like?', options: ['Apple', 'Banana', 'Cherry'], is_multi_select: false }
            ],
            toolAction: 'Asking user for',
            toolSummary: 'User survey'
        })

        expect(canonical.questions).toHaveLength(1)
        expect(canonical.questions[0]).toEqual({
            question: 'Which fruit do you like?',
            options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
            multiSelect: false
        })
    })

    it('translates is_multi_select=true to multiSelect', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [{ question: 'Which colors?', options: ['Red', 'Green'], is_multi_select: true }]
        })
        expect(canonical.questions[0]?.multiSelect).toBe(true)
    })

    it('preserves question order across multiple questions', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [
                { question: 'Q1', options: ['A'], is_multi_select: false },
                { question: 'Q2', options: ['B'], is_multi_select: true },
                { question: 'Q3', options: ['C'], is_multi_select: false }
            ]
        })
        expect(canonical.questions.map((q) => q.question)).toEqual(['Q1', 'Q2', 'Q3'])
    })

    it('trims whitespace from question text and option labels', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [{ question: '  Pick one  ', options: ['  Foo  ', 'Bar'], is_multi_select: false }]
        })
        expect(canonical.questions[0]?.question).toBe('Pick one')
        expect(canonical.questions[0]?.options[0]?.label).toBe('Foo')
    })

    it('drops empty/whitespace-only option labels', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [{ question: 'Pick', options: ['Foo', '  ', ''], is_multi_select: false }]
        })
        expect(canonical.questions[0]?.options).toEqual([{ label: 'Foo' }])
    })

    it('returns an empty questions array for malformed/missing input (never throws)', () => {
        expect(buildCanonicalAskUserQuestionInput(undefined)).toEqual({ questions: [] })
        expect(buildCanonicalAskUserQuestionInput(null)).toEqual({ questions: [] })
        expect(buildCanonicalAskUserQuestionInput({})).toEqual({ questions: [] })
        expect(buildCanonicalAskUserQuestionInput({ questions: 'not-an-array' })).toEqual({ questions: [] })
        expect(buildCanonicalAskUserQuestionInput({ questions: [null, 42, 'x'] })).toEqual({ questions: [] })
    })

    it('drops a question with neither text nor options', () => {
        const canonical = buildCanonicalAskUserQuestionInput({
            questions: [{ question: '', options: [] }, { question: 'Real question', options: ['A'] }]
        })
        expect(canonical.questions).toHaveLength(1)
        expect(canonical.questions[0]?.question).toBe('Real question')
    })
})
