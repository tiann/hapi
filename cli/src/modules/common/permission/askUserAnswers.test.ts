import { describe, expect, it } from 'vitest'
import { formatAskUserAnswersJson, mapAskUserAnswers } from './askUserAnswers'

const INPUT = {
    questions: [
        {
            id: 'deploy-target',
            question: 'Deploy to which environment?',
            header: 'Deploy',
            options: [
                { label: 'Staging (Recommended)', description: 'safe' },
                { label: 'Production', description: 'live' }
            ]
        },
        {
            id: 'notes',
            question: 'Anything else?',
            options: [{ label: 'No' }]
        },
        {
            id: 'free',
            question: 'Branch name?'
        }
    ]
}

describe('mapAskUserAnswers', () => {
    it('maps index-keyed labels onto per-question ids', () => {
        const answers = mapAskUserAnswers(INPUT, {
            '0': ['Staging (Recommended)'],
            '1': ['No']
        })
        expect(answers).toEqual([
            { id: 'deploy-target', selected: ['Staging (Recommended)'] },
            { id: 'notes', selected: ['No'] },
            { id: 'free', selected: [] }
        ])
    })

    it('splits free-text Other answers into custom', () => {
        const answers = mapAskUserAnswers(INPUT, {
            '0': ['Production'],
            '2': ['feature/ask-user']
        })
        expect(answers[0]).toEqual({ id: 'deploy-target', selected: ['Production'] })
        expect(answers[2]).toEqual({ id: 'free', selected: [], custom: 'feature/ask-user' })
        expect(formatAskUserAnswersJson(answers)).toBe(JSON.stringify({ answers }))
    })

    it('treats a non-label value on an option question as custom', () => {
        const answers = mapAskUserAnswers(INPUT, { '0': ['Staging (Recommended)', 'use staging box 2'] })
        expect(answers[0]).toEqual({
            id: 'deploy-target',
            selected: ['Staging (Recommended)'],
            custom: 'use staging box 2'
        })
    })

    it('falls back to index ids when questions carry no id', () => {
        const answers = mapAskUserAnswers(
            { questions: [{ question: 'Proceed?' }] },
            { '0': ['yes'] }
        )
        expect(answers).toEqual([{ id: "0", selected: [], custom: "yes" }])
    })

    it('accepts nested {answers} payloads (request_user_input dialect)', () => {
        const answers = mapAskUserAnswers(INPUT, {
            '0': { answers: ['Staging (Recommended)'] }
        })
        expect(answers[0]).toEqual({ id: 'deploy-target', selected: ['Staging (Recommended)'] })
    })

    it('maps multi-select and preserves question order with sparse keys', () => {
        const answers = mapAskUserAnswers(INPUT, {
            '0': ['Production', 'Staging (Recommended)']
        })
        expect(answers[0]?.selected).toEqual(['Production', 'Staging (Recommended)'])
        expect(answers[1]).toEqual({ id: 'notes', selected: [] })
    })

    it('ignores empty/whitespace values', () => {
        const answers = mapAskUserAnswers(INPUT, { '0': ['  '] })
        expect(answers[0]).toEqual({ id: 'deploy-target', selected: [] })
    })

    it('tolerates malformed input', () => {
        expect(mapAskUserAnswers(null, { '0': ['x'] })).toEqual([])
        expect(mapAskUserAnswers({ questions: 'nope' }, {})).toEqual([])
    })
})
