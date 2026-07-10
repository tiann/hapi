import { describe, expect, it } from 'vitest'
import {
    getCodexComposerReasoningEffortOptions,
    getCodexModelReasoningEffortOptions
} from './codexReasoningEffortOptions'

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

    it('uses the default Codex model catalog efforts for auto model selection', () => {
        expect(getCodexModelReasoningEffortOptions('auto', [
            {
                id: 'gpt-5.6-sol',
                isDefault: true,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            },
            {
                id: 'gpt-5.6-luna',
                isDefault: false,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
            }
        ])).toEqual([
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'XHigh' },
            { value: 'max', name: 'Max' },
            { value: 'ultra', name: 'Ultra' }
        ])
    })

    it('uses the explicitly selected Codex model effort subset', () => {
        expect(getCodexModelReasoningEffortOptions('GPT-5.6-LUNA', [
            {
                id: 'gpt-5.6-sol',
                isDefault: true,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            },
            {
                id: 'gpt-5.6-luna',
                isDefault: false,
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
            }
        ])).toEqual([
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'XHigh' },
            { value: 'max', name: 'Max' }
        ])
    })

    it('builds Codex composer options from the active model catalog', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'codex', [
            { value: 'max', name: 'Max' },
            { value: 'ultra', name: 'Ultra' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' }
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
