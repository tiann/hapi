import { describe, expect, it } from 'vitest'
import {
    formatCodexReasoningLabel,
    formatCompactCodexReasoningLabel,
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowCodexReasoningLabel,
    shouldShowReasoningStatusLabel
} from './codexStatusLabels'

describe('codexStatusLabels', () => {
    it('formats unset and default effort as effort default', () => {
        expect(formatCodexReasoningLabel(null)).toBe('effort default')
        expect(formatCodexReasoningLabel(undefined)).toBe('effort default')
        expect(formatCodexReasoningLabel('default')).toBe('effort default')
        expect(formatCodexReasoningLabel('  DEFAULT  ')).toBe('effort default')
    })

    it('formats selected efforts', () => {
        expect(formatCodexReasoningLabel('xhigh')).toBe('effort xhigh')
        expect(formatCodexReasoningLabel('Ultra')).toBe('effort ultra')
    })

    it('can omit the reasoning field label', () => {
        expect(formatCodexReasoningLabel('xhigh', false)).toBe('xhigh')
        expect(formatCodexReasoningLabel(null, false)).toBe('default')
    })

    it('formats compact effort-only labels', () => {
        expect(formatCompactCodexReasoningLabel(null)).toBe('default')
        expect(formatCompactCodexReasoningLabel('default')).toBe('default')
        expect(formatCompactCodexReasoningLabel('xhigh')).toBe('xhigh')
        expect(formatCompactCodexReasoningLabel(' Ultra ')).toBe('ultra')
    })

    it('only shows the label for codex and opencode', () => {
        expect(shouldShowCodexReasoningLabel('codex')).toBe(true)
        expect(shouldShowCodexReasoningLabel('opencode')).toBe(true)
        expect(shouldShowCodexReasoningLabel('claude')).toBe(false)
        expect(shouldShowCodexReasoningLabel(null)).toBe(false)
    })
})

describe('effort status metadata', () => {
    it('formats Pi reasoning labels with the shared formatter', () => {
        expect(formatReasoningLabel('MAX')).toBe('effort max')
        expect(formatCompactReasoningLabel(' MAX ')).toBe('max')
    })

    it('uses model reasoning effort for Codex/OpenCode and ordinary effort for other effort flavors', () => {
        expect(getReasoningEffortForFlavor('codex', 'xhigh', 'max')).toBe('xhigh')
        expect(getReasoningEffortForFlavor('opencode', 'high', 'max')).toBe('high')
        expect(getReasoningEffortForFlavor('pi', 'xhigh', 'max')).toBe('max')
        expect(getReasoningEffortForFlavor('claude', 'xhigh', 'max')).toBe('max')
        expect(getReasoningEffortForFlavor('grok', 'xhigh', 'max')).toBe('max')
        expect(getReasoningEffortForFlavor('agy', 'xhigh', 'max')).toBe('max')
        expect(getReasoningEffortForFlavor('cursor', 'xhigh', 'max')).toBeNull()
        expect(getReasoningEffortForFlavor(null, 'xhigh', 'max')).toBeNull()
    })

    it('shows unset defaults where every model takes an effort and requires a real Pi/AGY effort', () => {
        for (const flavor of ['codex', 'opencode', 'claude', 'grok']) {
            expect(shouldShowReasoningStatusLabel(flavor, null)).toBe(true)
        }
        expect(shouldShowReasoningStatusLabel('pi', 'max')).toBe(true)
        expect(shouldShowReasoningStatusLabel('pi', null)).toBe(false)
        expect(shouldShowReasoningStatusLabel('pi', '   ')).toBe(false)
        expect(shouldShowReasoningStatusLabel('agy', 'high')).toBe(true)
        expect(shouldShowReasoningStatusLabel('agy', null)).toBe(false)
        expect(shouldShowReasoningStatusLabel('cursor', 'max')).toBe(false)
        expect(shouldShowReasoningStatusLabel(null, 'max')).toBe(false)
    })
})
