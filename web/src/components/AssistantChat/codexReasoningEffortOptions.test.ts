import { describe, expect, it } from 'vitest'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'

describe('getCodexComposerReasoningEffortOptions', () => {
    it('includes the default option and preset values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('preserves non-preset current values for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('minimal', 'codex')).toEqual([
            { value: null, label: 'Default' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' }
        ])
    })

    it('returns no options for OpenCode until dynamic options are available', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode')).toEqual([])
        expect(getCodexComposerReasoningEffortOptions(null, 'opencode', [])).toEqual([])
    })

    it('builds OpenCode options from ACP-reported values', () => {
        expect(getCodexComposerReasoningEffortOptions('low', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })

    it('preserves unsupported current OpenCode values in the dropdown', () => {
        expect(getCodexComposerReasoningEffortOptions('high', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'high', label: 'High' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' }
        ])
    })
})
