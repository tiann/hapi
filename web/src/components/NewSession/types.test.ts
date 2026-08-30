import { CLAUDE_MODEL_PRESETS, getClaudeModelLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { CLAUDE_EFFORT_OPTIONS, GROK_EFFORT_OPTIONS, MODEL_OPTIONS, isOpencodeReasoningEffortValid } from './types'

describe('Claude model options', () => {
    it('derives options from shared Claude model presets', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default' },
            ...CLAUDE_MODEL_PRESETS.map((model) => ({
                value: model,
                label: getClaudeModelLabel(model) ?? model
            }))
        ])
    })

    it('exposes friendly labels for Claude model presets', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]'])
        expect(getClaudeModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
        expect(getClaudeModelLabel('fable[1m]')).toBe('Fable 1M')
    })
})

describe('Claude effort options', () => {
    it('matches supported effort presets in expected order', () => {
        expect(CLAUDE_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })
})

describe('Grok effort options', () => {
    it('offers only the effort levels supported by grok-4.5', () => {
        expect(GROK_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
        ])
    })
})

describe('isOpencodeReasoningEffortValid', () => {
    it('accepts default always', () => {
        expect(isOpencodeReasoningEffortValid('default', ['low'])).toBe(true)
        expect(isOpencodeReasoningEffortValid('default', null)).toBe(true)
    })

    it('validates against dynamic variants when loaded', () => {
        expect(isOpencodeReasoningEffortValid('low', ['low', 'high', 'max'])).toBe(true)
        expect(isOpencodeReasoningEffortValid('medium', ['low', 'high', 'max'])).toBe(false)
    })

    it('falls back to the static opencode list (xhigh excluded) when catalog is unavailable', () => {
        expect(isOpencodeReasoningEffortValid('medium', null)).toBe(true)
        expect(isOpencodeReasoningEffortValid('xhigh', null)).toBe(false)
        expect(isOpencodeReasoningEffortValid('max', null)).toBe(true)
    })
})
