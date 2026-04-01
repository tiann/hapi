import { describe, expect, it } from 'vitest'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'

describe('getClaudeComposerEffortOptions', () => {
    it('includes the active non-preset Claude effort in the options list', () => {
        expect(getClaudeComposerEffortOptions('ultra')).toEqual([
            { value: null, label: 'Auto' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })

    it('does not duplicate preset Claude effort values', () => {
        expect(getClaudeComposerEffortOptions('high')).toEqual([
            { value: null, label: 'Auto' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })
})
