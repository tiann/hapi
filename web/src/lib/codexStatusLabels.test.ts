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

    it('pins the full wire-field routing matrix', () => {
        const mre = ['codex', 'opencode']
        const generic = ['agy', 'claude', 'copilot', 'grok', 'kimi', 'pi']
        const none = ['cursor', 'dsh', 'gemini', 'unknown']
        for (const flavor of [...mre, ...generic, ...none, null]) {
            const value = getReasoningEffortForFlavor(flavor, 'mre-value', 'effort-value')
            if (mre.includes(flavor ?? '')) expect(value, String(flavor)).toBe('mre-value')
            else if (generic.includes(flavor ?? '')) expect(value, String(flavor)).toBe('effort-value')
            else expect(value, String(flavor)).toBeNull()
        }
    })

    it('pins the full default-label visibility matrix', () => {
        const always = ['codex', 'opencode', 'claude', 'grok']
        const realOnly = ['agy', 'copilot', 'kimi', 'pi']
        const never = ['cursor', 'dsh', 'gemini', 'unknown']
        for (const flavor of [...always, ...realOnly, ...never, null]) {
            const unset = shouldShowReasoningStatusLabel(flavor, null)
            const real = shouldShowReasoningStatusLabel(flavor, 'high')
            if (always.includes(flavor ?? '')) {
                expect(unset, String(flavor)).toBe(true)
                expect(real, String(flavor)).toBe(true)
            } else if (realOnly.includes(flavor ?? '')) {
                expect(unset, String(flavor)).toBe(false)
                expect(real, String(flavor)).toBe(true)
            } else {
                expect(unset, String(flavor)).toBe(false)
                expect(real, String(flavor)).toBe(false)
            }
        }
    })
})
