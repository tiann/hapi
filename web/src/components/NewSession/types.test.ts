import { CLAUDE_MODEL_FALLBACK_OPTIONS, getClaudeModelLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import { CLAUDE_EFFORT_OPTIONS, GROK_EFFORT_OPTIONS, MODEL_OPTIONS } from './types'

describe('Claude model options', () => {
    it('derives options from the fallback offer list (no live catalog)', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default' },
            ...CLAUDE_MODEL_FALLBACK_OPTIONS.map(({ value, label }) => ({ value, label }))
        ])
    })

    it('the fallback offer list has no bare/[1m] duplicate pairs', () => {
        for (const option of CLAUDE_MODEL_FALLBACK_OPTIONS) {
            expect(option.value.endsWith('[1m]')).toBe(false)
        }
        expect(CLAUDE_MODEL_FALLBACK_OPTIONS.map((option) => option.value)).toEqual(
            ['opus', 'fable', 'sonnet', 'haiku']
        )
    })

    it('exposes friendly labels for recognized Claude model aliases (role B), including legacy [1m] ids', () => {
        expect(getClaudeModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
        expect(getClaudeModelLabel('fable[1m]')).toBe('Fable 1M')
        expect(getClaudeModelLabel('haiku')).toBe('Haiku')
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
