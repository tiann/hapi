import { describe, expect, it } from 'bun:test'
import { SessionServiceTierRequestSchema } from './apiTypes'
import { codexModelHasUltrafastTier, fromCodexServiceTier, toCodexServiceTier } from './codexServiceTier'

describe('Codex service tiers', () => {
    it('round-trips Ultrafast without confusing it with Fast or Standard', () => {
        expect(toCodexServiceTier('ultrafast')).toBe('ultrafast')
        expect(fromCodexServiceTier('ultrafast')).toBe('ultrafast')
        expect(toCodexServiceTier('fast')).toBe('priority')
        expect(fromCodexServiceTier('priority')).toBe('fast')
        expect(toCodexServiceTier('standard')).toBeNull()
        expect(toCodexServiceTier(undefined)).toBeUndefined()
    })

    it('requires a specific catalog capability, rather than a model-family guess', () => {
        expect(codexModelHasUltrafastTier(undefined)).toBe(false)
        expect(codexModelHasUltrafastTier({ serviceTiers: ['priority', 'fast'] })).toBe(false)
        expect(codexModelHasUltrafastTier({ serviceTiers: ['ultrafast'] })).toBe(true)
    })
})


it('accepts Ultrafast on the wire but rejects arbitrary tier strings', () => {
    expect(SessionServiceTierRequestSchema.safeParse({ serviceTier: 'ultrafast' }).success).toBe(true)
    expect(SessionServiceTierRequestSchema.safeParse({ serviceTier: 'turbo' }).success).toBe(false)
})
