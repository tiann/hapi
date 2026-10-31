import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('keeps the large budget for sessions stored with a [1m] alias', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('opus[1m]', 'claude')).toBe(990_000)
    })

    it('uses the large budget for the aliases, which now resolve to native 1M models', () => {
        expect(getContextBudgetTokens('opus', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('sonnet', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('haiku', 'claude')).toBe(990_000)
    })

    it('uses the default Claude budget for full Claude model names', () => {
        expect(getContextBudgetTokens('claude-sonnet-4-6', 'claude')).toBe(190_000)
    })

    it('uses the large budget for a full Claude model name carrying a [1m] suffix', () => {
        expect(getContextBudgetTokens('claude-opus-4-8[1m]', 'claude')).toBe(990_000)
    })

    it('uses the large budget for Fable even under its bare id (1M window)', () => {
        expect(getContextBudgetTokens('claude-fable-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('fable[1m]', 'claude')).toBe(990_000)
    })

    it('uses Codex app-server context window with headroom', () => {
        expect(getContextBudgetTokens('gpt-5.4', 'codex')).toBe(248_400)
    })

    it('parses context budget from Cursor wire ids', () => {
        expect(getContextBudgetTokens('composer-2.5-fast[context=300k]', 'cursor')).toBe(290_000)
    })

    it('returns null for unknown non-Claude sessions', () => {
        expect(getContextBudgetTokens('gemini-3-pro', 'gemini')).toBeNull()
    })
})
