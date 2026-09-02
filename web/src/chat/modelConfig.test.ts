import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    // A real get_context_usage measurement (claude 2.1.233, 2026-08-16) showed
    // sonnet's actual window is 967,000 regardless of the "[1m]" suffix -- the
    // suffix carries no window information. The old suffix-based heuristic
    // treated "[1m]" as meaning the full 1,000,000 window, over-counting
    // sonnet[1m]'s budget by 3.4%; this asserts the corrected, family-based
    // value instead.
    it('uses the measured sonnet family window for the [1m] preset (not the legacy full-1M guess)', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(957_000)
    })

    it('uses the same measured sonnet family window for the bare preset (no more 4.8x under-count)', () => {
        expect(getContextBudgetTokens('sonnet', 'claude')).toBe(957_000)
    })

    it('uses the measured opus family window for both the bare and [1m] preset', () => {
        expect(getContextBudgetTokens('opus', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('opus[1m]', 'claude')).toBe(990_000)
    })

    it('uses the resolved SDK id for sonnet/opus the same way as their short aliases', () => {
        expect(getContextBudgetTokens('claude-sonnet-5', 'claude')).toBe(957_000)
        expect(getContextBudgetTokens('claude-opus-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-sonnet-5[1m]', 'claude')).toBe(957_000)
    })

    it('uses the legacy 200k default for haiku (measured: exactly the historical default)', () => {
        expect(getContextBudgetTokens('haiku', 'claude')).toBe(190_000)
    })

    it('uses the default Claude budget for an unrecognized full Claude model name from another generation', () => {
        // "claude-sonnet-4-6" is not one of the model ids/aliases this file has
        // an actual measurement for (see resolveClaudeContextWindowFamily) --
        // it must fall through to the legacy suffix-based guess rather than
        // being assumed to share the current "sonnet" family's window.
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

    // Full bare/[1m] alias regression matrix (plan §Phase 4): every alias HAPI
    // has stored on a session (past or present) must resolve to the measured
    // value, haiku is the only one still at 200,000.
    it('bare alias regression matrix matches the real measured windows exactly', () => {
        const expected: Array<[string, number]> = [
            ['sonnet', 957_000],
            ['sonnet[1m]', 957_000],
            ['opus', 990_000],
            ['opus[1m]', 990_000],
            ['fable', 990_000],
            ['fable[1m]', 990_000],
            ['haiku', 190_000],
        ]
        for (const [alias, budget] of expected) {
            expect(getContextBudgetTokens(alias, 'claude')).toBe(budget)
        }
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
