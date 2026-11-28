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

    it('uses arbitrary model-reported efforts for Codex', () => {
        expect(getCodexComposerReasoningEffortOptions('extreme', 'codex', [
            { value: 'low' },
            { value: 'medium' },
            { value: 'high' },
            { value: 'xhigh' },
            { value: 'max' },
            { value: 'ultra' },
            { value: 'extreme' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'extreme', label: 'Extreme' }
        ])
    })

    it('keeps an unsupported current Codex effort visible', () => {
        expect(getCodexComposerReasoningEffortOptions('ultra', 'codex', [
            { value: 'low' },
            { value: 'max' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'ultra', label: 'Ultra' },
            { value: 'low', label: 'Low' },
            { value: 'max', label: 'Max' }
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

    it('drops provider-default entries from dynamic options so Default is not duplicated', () => {
        expect(getCodexComposerReasoningEffortOptions('default', 'opencode', [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
            { value: 'max', name: 'Max' },
            { value: 'default', name: 'Default' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])

        expect(getCodexComposerReasoningEffortOptions('', 'dsh', [
            { value: '', name: 'Provider default' },
            { value: 'Default', name: 'Default' },
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
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
    it('builds DSH options from the fixed thought_level presets (no Default row)', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh')).toEqual([
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])
    })

    it('prefers discovered DSH options over the presets', () => {
        expect(getCodexComposerReasoningEffortOptions('low', 'dsh', [
            { value: 'low', name: 'Low' },
            { value: 'ultra', name: 'Ultra' }
        ])).toEqual([
            { value: 'low', label: 'Low' },
            { value: 'ultra', label: 'Ultra' }
        ])
    })
})

describe('getCodexComposerReasoningEffortOptions — dsh thought_level', () => {
    // DSH advertises a single session-wide `reasoning_effort` config option
    // (category thought_level). Its stock adapter always declares a default
    // effort, so the option never offers "" and dsh rejects "" — there is no
    // Default row unless the live list itself carries the provider default.
    it('adds the Default row only when the live list offers the provider default', () => {
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh', [
            { value: '', name: 'Provider default' },
            { value: 'high', name: 'High' }
        ])).toEqual([
            { value: null, label: 'Default' },
            { value: 'high', label: 'High' }
        ])
    })

    it('hides the picker when the live list says the model has no thought levels', () => {
        // An EMPTY list is the catalog's positive "nothing to pick" answer
        // (undefined means undiscovered and falls back to the presets).
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh', [])).toEqual([])
        expect(getCodexComposerReasoningEffortOptions(null, 'dsh', undefined)).toHaveLength(4)
    })

    it('keeps an out-of-set current effort visible so the picker never loses the selection', () => {
        expect(getCodexComposerReasoningEffortOptions('medium', 'dsh')).toEqual([
            { value: 'medium', label: 'Medium' },
            { value: 'off', label: 'Off' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' }
        ])
    })
})
