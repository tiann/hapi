import { describe, expect, it } from 'vitest'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'

describe('getClaudeComposerEffortOptions', () => {
    it('includes the active non-preset Claude effort in the options list', () => {
        expect(getClaudeComposerEffortOptions('ultra')).toEqual([
            { value: null, label: 'Auto' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })

    it('does not duplicate preset Claude effort values', () => {
        expect(getClaudeComposerEffortOptions('high')).toEqual([
            { value: null, label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })
})

describe('getClaudeComposerEffortOptions with the model\'s levels', () => {
    it('offers only the levels the current model accepts', () => {
        expect(getClaudeComposerEffortOptions(null, ['low', 'medium', 'high', 'max'])).toEqual([
            { value: null, label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })

    it('offers only Auto for a model without effort control', () => {
        expect(getClaudeComposerEffortOptions(null, [])).toEqual([{ value: null, label: 'Auto' }])
    })

    it('still shows an active effort the model does not list', () => {
        expect(getClaudeComposerEffortOptions('xhigh', ['low'])).toEqual([
            { value: null, label: 'Auto' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'low', label: 'Low' },
        ])
    })
})
