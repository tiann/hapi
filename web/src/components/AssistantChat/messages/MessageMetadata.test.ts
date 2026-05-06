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

    it('labels token totals as billable to clarify that cache I/O is intentionally excluded', () => {
        const parts = buildMessageMetadataLabels({
            usage: { input_tokens: 100, output_tokens: 200 }
        })
        expect(parts.some(p => /\bbillable tokens\b/.test(p))).toBe(true)
        expect(parts.some(p => p.includes('300 billable tokens (100 in / 200 out)'))).toBe(true)
    })

    it('does not drop a Duration line when durationMs is exactly 0', () => {
        const parts = buildMessageMetadataLabels({ durationMs: 0 })
        expect(parts).toContain('Duration: 0.0s')
    })

    it('does not drop an Invoke line when invokedAt is the unix epoch', () => {
        const parts = buildMessageMetadataLabels({ invokedAt: 0 })
        expect(parts.some(p => p.startsWith('Invoke:'))).toBe(true)
    })

    it('omits the Invoke line when invokedAt is null or undefined', () => {
        expect(buildMessageMetadataLabels({ invokedAt: null }).some(p => p.startsWith('Invoke:'))).toBe(false)
        expect(buildMessageMetadataLabels({}).some(p => p.startsWith('Invoke:'))).toBe(false)
    })
})
