import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('uses the large budget only for explicit 1m Claude presets', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(990_000)
    })

    it('uses the default Claude budget for full Claude model names', () => {
        expect(getContextBudgetTokens('claude-sonnet-4-6', 'claude')).toBe(190_000)
    })

    it('returns null for non-Claude sessions', () => {
        expect(getContextBudgetTokens('gpt-5.4', 'codex')).toBeNull()
    })
})
