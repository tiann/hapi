import { describe, expect, it } from 'vitest'
import {
    formatEffortLabel,
    getFlavorTextClass,
    META_DOT_SEPARATOR_CLASS,
    supportsModelChange
} from './agentFlavorUtils'

describe('getFlavorTextClass', () => {
    it.each([
        ['claude', 'text-[var(--app-flavor-claude-text)] font-medium'],
        ['codex', 'text-[var(--app-flavor-codex-text)] font-medium'],
        ['gemini', 'text-[var(--app-flavor-gemini-text)] font-medium'],
        ['opencode', 'text-[var(--app-flavor-opencode-text)] font-medium'],
        ['cursor', 'text-[var(--app-flavor-cursor-text)] font-medium']
    ])('returns flavor class for %s', (flavor, expected) => {
        expect(getFlavorTextClass(flavor)).toBe(expected)
    })

    it('falls back for unknown flavors', () => {
        expect(getFlavorTextClass('mystery')).toBe('text-[var(--app-hint)] font-medium')
    })

    it('falls back for nullish values', () => {
        expect(getFlavorTextClass(null)).toBe('text-[var(--app-hint)] font-medium')
        expect(getFlavorTextClass(undefined)).toBe('text-[var(--app-hint)] font-medium')
    })

    it('normalizes whitespace and casing', () => {
        expect(getFlavorTextClass('  CoDeX  ')).toBe('text-[var(--app-flavor-codex-text)] font-medium')
    })
})

describe('formatEffortLabel', () => {
    it('returns null for nullish and blank values', () => {
        expect(formatEffortLabel(null)).toBeNull()
        expect(formatEffortLabel('')).toBeNull()
        expect(formatEffortLabel('   ')).toBeNull()
    })

    it('title-cases segmented effort labels', () => {
        expect(formatEffortLabel('very-high')).toBe('Very High')
        expect(formatEffortLabel('max_reasoning effort')).toBe('Max Reasoning Effort')
    })
})

describe('META_DOT_SEPARATOR_CLASS', () => {
    it('exports the expected separator class', () => {
        expect(META_DOT_SEPARATOR_CLASS).toBe('text-[var(--app-hint)] opacity-40')
    })
})

describe('supportsModelChange', () => {
    it.each(['claude', 'gemini'])('returns true for %s', (flavor) => {
        expect(supportsModelChange(flavor)).toBe(true)
    })

    it.each(['codex', 'cursor', 'opencode', 'mystery'])('returns false for %s', (flavor) => {
        expect(supportsModelChange(flavor)).toBe(false)
    })

    it('returns false for nullish values', () => {
        expect(supportsModelChange(null)).toBe(false)
        expect(supportsModelChange(undefined)).toBe(false)
        expect(supportsModelChange('')).toBe(false)
    })

    it('normalizes whitespace and casing', () => {
        expect(supportsModelChange('  Claude  ')).toBe(true)
        expect(supportsModelChange('GEMINI')).toBe(true)
    })
})
