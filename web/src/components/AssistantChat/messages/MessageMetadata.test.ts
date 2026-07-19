import { describe, expect, it } from 'vitest'
import { buildMessageMetadataLabels } from './MessageMetadata'

describe('buildMessageMetadataLabels', () => {
    it('renders Model label with the per-message model name', () => {
        const parts = buildMessageMetadataLabels({
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 3, output_tokens: 15, service_tier: 'standard' }
        })
        expect(parts).toContain('Model: claude-sonnet-4-6')
    })

    it('does not render service_tier as the model when model is missing', () => {
        const parts = buildMessageMetadataLabels({
            usage: { input_tokens: 3, output_tokens: 15, service_tier: 'priority' }
        })
        // service_tier value (e.g. "priority", "standard_only") must never be
        // surfaced as the model id.
        expect(parts).not.toContain('Model: priority')
        expect(parts.some(p => p.startsWith('Model:'))).toBe(false)
        expect(parts).toContain('Tier: priority')
    })

    it('omits both Model and Tier labels when service_tier is the default standard', () => {
        const parts = buildMessageMetadataLabels({
            usage: { input_tokens: 3, output_tokens: 15, service_tier: 'standard' }
        })
        expect(parts.some(p => p.startsWith('Model:'))).toBe(false)
        expect(parts.some(p => p.startsWith('Tier:'))).toBe(false)
    })

    it('appends non-standard service_tier in parentheses next to the model id', () => {
        const parts = buildMessageMetadataLabels({
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 3, output_tokens: 15, service_tier: 'priority' }
        })
        expect(parts).toContain('Model: claude-sonnet-4-6 (priority)')
    })

    it('returns an empty list when nothing is provided', () => {
        expect(buildMessageMetadataLabels({})).toEqual([])
    })

    it('renders the token total and input/output breakdown without billing claims', () => {
        const parts = buildMessageMetadataLabels({
            usage: { input_tokens: 100, output_tokens: 200 }
        })
        expect(parts).toContain('Tokens: 300 total (100 in / 200 out)')
        expect(parts.some(p => /\bbillable\b/.test(p))).toBe(false)
    })

    it('does not drop a Duration line when durationMs is exactly 0', () => {
        const parts = buildMessageMetadataLabels({ durationMs: 0 })
        expect(parts).toContain('Duration: 0.0s')
    })

    // Proof of Invariance — single-turn inputs (turnCount omitted, or < 2)
    // must produce byte-identical output to the pre-aggregate footer so
    // existing single-turn cards do not regress visually.
    it('single-turn input is byte-identical with or without turnCount=1', () => {
        const base = {
            durationMs: 1234,
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 3, output_tokens: 19, service_tier: 'standard' }
        }
        const withoutTurn = buildMessageMetadataLabels(base)
        const withTurnOne = buildMessageMetadataLabels({ ...base, turnCount: 1 })
        expect(withTurnOne).toEqual(withoutTurn)
    })

    // Byte-for-byte lock on the pre-aggregate label set. PR #555 introduced
    // this exact shape; any regression to ordering, label strings, or token
    // formatting would surface visually in single-turn cards.
    it('pre-aggregate single-turn call produces the exact label sequence', () => {
        const parts = buildMessageMetadataLabels({
            durationMs: 1234,
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 3, output_tokens: 19, service_tier: 'standard' }
        })
        // The Invoke value depends on the runner's timezone, so match its
        // shape rather than a literal time string. The remaining labels are
        // timezone-independent and locked exactly.
        expect(parts).toEqual([
            'Duration: 1.2s',
            'Model: claude-sonnet-4-6',
            'Tokens: 22 total (3 in / 19 out)'
        ])
    })

    it('switches to Models/Total/N turns labels only when turnCount >= 2', () => {
        const parts = buildMessageMetadataLabels({
            model: 'claude-sonnet-4-6, claude-haiku-4-5-20251001',
            usage: { input_tokens: 100, output_tokens: 200, service_tier: 'standard' },
            turnCount: 3
        })
        expect(parts).toContain('Models: claude-sonnet-4-6, claude-haiku-4-5-20251001')
        expect(parts.some(p => p.startsWith('Model:'))).toBe(false)
        expect(parts).toContain('Tokens: 300 total (100 in / 200 out)')
        expect(parts).toContain('3 turns')
    })

    it('keeps the singular Model label when an aggregated group has only one distinct model', () => {
        // Mid-session model switch is rare; the common multi-turn case is one
        // model repeated across N turns. The label must stay singular then.
        const parts = buildMessageMetadataLabels({
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 20, service_tier: 'standard' },
            turnCount: 2
        })
        expect(parts).toContain('Model: claude-sonnet-4-6')
        expect(parts.some(p => p.startsWith('Models:'))).toBe(false)
        expect(parts).toContain('2 turns')
    })

    it('omits Duration on aggregated footers when durationMs is undefined', () => {
        const parts = buildMessageMetadataLabels({
            model: 'claude-sonnet-4-6, claude-haiku-4-5-20251001',
            usage: { input_tokens: 10, output_tokens: 20, service_tier: 'standard' },
            turnCount: 2
        })
        expect(parts.some(p => p.startsWith('Duration:'))).toBe(false)
    })
})
