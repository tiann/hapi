import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('uses the large budget for the current Claude default model', () => {
        expect(getContextBudgetTokens(null, 'claude')).toBe(990_000)
    })

    it('uses the large budget for Sonnet 5 aliases', () => {
        expect(getContextBudgetTokens('sonnet', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-sonnet-5', 'claude')).toBe(990_000)
    })

    it('uses the default budget for standard Sonnet 4.6 aliases', () => {
        expect(getContextBudgetTokens('claude-sonnet-4-6', 'claude')).toBe(190_000)
    })

    it('uses the large budget for Fable 5 model aliases and full model names', () => {
        expect(getContextBudgetTokens('fable', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-fable-5', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-fable-5[1m]', 'claude')).toBe(990_000)
    })

    it('uses the large budget for explicit Sonnet 4.6 1M model names', () => {
        expect(getContextBudgetTokens('sonnet[1m]', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-sonnet-4-6[1m]', 'claude')).toBe(990_000)
    })

    it('uses the default Claude budget for non-1M Claude model names', () => {
        expect(getContextBudgetTokens('haiku', 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('haiku[1m]', 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('claude-haiku-4-5[1m]', 'claude')).toBe(190_000)
        expect(getContextBudgetTokens('claude-opus-4-80', 'claude')).toBe(190_000)
    })

    it('uses the large budget for full Opus 4.8 model names', () => {
        expect(getContextBudgetTokens('claude-opus-4-8', 'claude')).toBe(990_000)
        expect(getContextBudgetTokens('claude-opus-4-8-20260530', 'claude')).toBe(990_000)
    })

    it('returns null for unknown non-Claude model sessions', () => {
        expect(getContextBudgetTokens('gpt-custom-preview', 'codex')).toBeNull()
    })

    it('uses live Codex CLI catalog budgets for GPT-5.6 Codex models', () => {
        expect(getContextBudgetTokens('gpt-5.6', 'codex')).toBe(362_000)
        expect(getContextBudgetTokens('gpt-5.6-sol', 'codex')).toBe(362_000)
        expect(getContextBudgetTokens('gpt-5.6-terra', 'codex')).toBe(362_000)
        expect(getContextBudgetTokens('gpt-5.6-luna', 'codex')).toBe(362_000)
    })

    it('uses live Codex CLI catalog budgets for GPT-5.5/GPT-5.4 and Spark models', () => {
        expect(getContextBudgetTokens('gpt-5.5', 'codex')).toBe(262_000)
        expect(getContextBudgetTokens('gpt-5.4', 'codex')).toBe(262_000)
        expect(getContextBudgetTokens('gpt-5.4-mini', 'codex')).toBe(262_000)
        expect(getContextBudgetTokens('gpt-5.3-codex-spark', 'codex')).toBe(118_000)
    })

    it('uses official effective budgets for CC-api models', () => {
        expect(getContextBudgetTokens('doubao-seed-2.1-pro', 'cc-api')).toBe(252_144)
        expect(getContextBudgetTokens('glm-5.2[1m]', 'cc-api')).toBe(990_000)
        expect(getContextBudgetTokens('glm-5.2', 'cc-api')).toBe(990_000)
        expect(getContextBudgetTokens('minimax-m3', 'cc-api')).toBe(502_000)
        expect(getContextBudgetTokens('kimi-k3', 'cc-api')).toBe(1_038_576)
    })

    it('uses the official 1M context for both CC-deepseek V4 models', () => {
        expect(getContextBudgetTokens('deepseek-v4-pro[1m]', 'claude-deepseek')).toBe(990_000)
        expect(getContextBudgetTokens('deepseek-v4-flash', 'claude-deepseek')).toBe(990_000)
    })

    it('uses official Coding Plan budgets for Ark models', () => {
        expect(getContextBudgetTokens('glm-5.2', 'claude-ark')).toBe(1_014_000)
        expect(getContextBudgetTokens('deepseek-v4-pro', 'claude-ark')).toBe(1_014_000)
        expect(getContextBudgetTokens('deepseek-v4-flash', 'claude-ark')).toBe(1_014_000)
        expect(getContextBudgetTokens('minimax-m3', 'claude-ark')).toBe(502_000)
        expect(getContextBudgetTokens('minimax-m2.7', 'claude-ark')).toBe(190_000)
        expect(getContextBudgetTokens('kimi-k2.7-code', 'claude-ark')).toBe(246_000)
    })
})
