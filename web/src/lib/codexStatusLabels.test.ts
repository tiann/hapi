import { describe, expect, it } from 'vitest'
import {
    formatReasoningLabel,
    formatCompactReasoningLabel,
    getReasoningEffortForFlavor,
    shouldShowReasoningStatusLabel
} from './codexStatusLabels'

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
