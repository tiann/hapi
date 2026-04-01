import { describe, expect, it } from 'vitest'
import { normalizeClaudeSessionEffort } from './effort'

describe('normalizeClaudeSessionEffort', () => {
    it('returns null when effort is missing', () => {
        expect(normalizeClaudeSessionEffort()).toBeNull()
    })

    it('returns null for auto-like values', () => {
        expect(normalizeClaudeSessionEffort('')).toBeNull()
        expect(normalizeClaudeSessionEffort('auto')).toBeNull()
        expect(normalizeClaudeSessionEffort('default')).toBeNull()
        expect(normalizeClaudeSessionEffort('  AUTO  ')).toBeNull()
    })

    it('normalizes supported effort values', () => {
        expect(normalizeClaudeSessionEffort('medium')).toBe('medium')
        expect(normalizeClaudeSessionEffort('high')).toBe('high')
        expect(normalizeClaudeSessionEffort('max')).toBe('max')
        expect(normalizeClaudeSessionEffort('  High ')).toBe('high')
    })
})
