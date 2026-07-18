import { describe, expect, it } from 'vitest'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'

describe('getClaudeComposerEffortOptions', () => {
    it('returns official CC-deepseek High and Max effort options', () => {
        expect(getClaudeComposerEffortOptions(null, 'claude-deepseek', 'deepseek-v4-pro[1m]')).toEqual([
            { value: null, label: 'Auto (Claude Code default: Max)' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
        expect(getClaudeComposerEffortOptions(null, 'claude-deepseek', 'deepseek-v4-flash')).toEqual([
            { value: null, label: 'Auto (Claude Code default: Max)' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })

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

    it('returns model-aware CC-api effort options for GLM', () => {
        expect(getClaudeComposerEffortOptions(null, 'cc-api', 'glm-5.2')).toEqual([
            { value: null, label: 'Auto' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })

    it('returns verified Claude-compatible CC-api effort options for Doubao', () => {
        expect(getClaudeComposerEffortOptions(null, 'cc-api', 'doubao-seed-2.1-pro')).toEqual([
            { value: null, label: 'Auto (Doubao default)' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ])
    })

    it('exposes only the official max CC-api effort for Kimi K3', () => {
        expect(getClaudeComposerEffortOptions(null, 'cc-api', 'kimi-k3')).toEqual([
            { value: null, label: 'Auto (K3 default: Max)' },
            { value: 'max', label: 'Max' },
        ])
    })

    it('does not expose fake CC-api effort levels for MiniMax', () => {
        expect(getClaudeComposerEffortOptions(null, 'cc-api', 'minimax-m3')).toEqual([
            { value: null, label: 'Auto (MiniMax default)' },
        ])
    })

    it('does not expose stale invalid CC-api effort for Kimi K3', () => {
        expect(getClaudeComposerEffortOptions('high', 'cc-api', 'kimi-k3')).toEqual([
            { value: null, label: 'Auto (K3 default: Max)' },
            { value: 'max', label: 'Max' },
        ])
    })
})
