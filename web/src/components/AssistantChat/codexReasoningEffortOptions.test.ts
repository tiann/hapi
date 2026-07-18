import { describe, expect, it } from 'vitest'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'

describe('getCodexComposerReasoningEffortOptions', () => {
    it('includes Auto-model default and conservative preset values', () => {
        expect(getCodexComposerReasoningEffortOptions(null)).toEqual([
            { value: null, label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('includes Max and Ultra for GPT-5.6 Sol live sessions', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'gpt-5.6-sol')).toEqual([
            { value: null, label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' }
        ])
    })

    it('keeps GPT-5.5 to locally effective levels', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'gpt-5.5')).toEqual([
            { value: null, label: 'Default' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('preserves an existing unsupported current value before model-specific presets', () => {
        expect(getCodexComposerReasoningEffortOptions('max', 'gpt-5.5')).toEqual([
            { value: null, label: 'Default' },
            { value: 'max', label: 'Max' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('preserves minimal as an existing current value even though it is not offered by default', () => {
        expect(getCodexComposerReasoningEffortOptions('minimal', 'gpt-5.5')[1]).toEqual({
            value: 'minimal',
            label: 'Minimal'
        })
    })
})
