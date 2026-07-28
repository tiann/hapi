import { describe, expect, it } from 'vitest'
import { formatCodexReasoningLabel, shouldShowCodexReasoningLabel } from './codexStatusLabels'

describe('codexStatusLabels', () => {
    it('formats unset and default effort as reasoning default', () => {
        expect(formatCodexReasoningLabel(null)).toBe('reasoning default')
        expect(formatCodexReasoningLabel(undefined)).toBe('reasoning default')
        expect(formatCodexReasoningLabel('default')).toBe('reasoning default')
        expect(formatCodexReasoningLabel('  DEFAULT  ')).toBe('reasoning default')
    })

    it('formats selected efforts', () => {
        expect(formatCodexReasoningLabel('xhigh')).toBe('reasoning xhigh')
        expect(formatCodexReasoningLabel('Ultra')).toBe('reasoning ultra')
    })

    it('only shows the label for codex and opencode', () => {
        expect(shouldShowCodexReasoningLabel('codex')).toBe(true)
        expect(shouldShowCodexReasoningLabel('opencode')).toBe(true)
        expect(shouldShowCodexReasoningLabel('claude')).toBe(false)
        expect(shouldShowCodexReasoningLabel(null)).toBe(false)
    })
})
