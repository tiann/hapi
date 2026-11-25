import { describe, expect, it } from 'vitest'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel } from './claudeModelOptions'

describe('getClaudeComposerModelOptions', () => {
    it('includes the active non-preset Claude model in the options list', () => {
        expect(getClaudeComposerModelOptions('claude-opus-4-1-20250805')).toEqual([
            { value: null, label: 'Default' },
            { value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' },
            { value: 'opus', label: 'Opus' },
            { value: 'fable', label: 'Fable' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })

    it('does not duplicate preset Claude models', () => {
        expect(getClaudeComposerModelOptions('opus')).toEqual([
            { value: null, label: 'Default' },
            { value: 'opus', label: 'Opus' },
            { value: 'fable', label: 'Fable' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'haiku', label: 'Haiku' },
        ])
    })
})

describe('getNextClaudeComposerModel', () => {
    it('cycles from a non-preset Claude model to the next selectable model instead of auto', () => {
        expect(getNextClaudeComposerModel('claude-opus-4-1-20250805')).toBe('opus')
    })
})
