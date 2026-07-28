import { describe, expect, it } from 'vitest'
import { SessionSchema } from './schemas'

function baseSession(overrides: Record<string, unknown> = {}) {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        namespace: 'default',
        seq: 0,
        createdAt: 1_000,
        updatedAt: 2_000,
        active: false,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        ...overrides
    }
}

describe('SessionSchema activeAt coerce', () => {
    it('keeps a numeric activeAt unchanged', () => {
        const parsed = SessionSchema.safeParse(baseSession({ activeAt: 42 }))
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.activeAt).toBe(42)
        }
    })

    it('coerces null activeAt to 0 without failing parse', () => {
        const parsed = SessionSchema.safeParse(baseSession({ activeAt: null }))
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.activeAt).toBe(0)
        }
    })

    it('coerces missing activeAt to 0 without failing parse', () => {
        const raw = baseSession()
        delete (raw as { activeAt?: number }).activeAt
        const parsed = SessionSchema.safeParse(raw)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.activeAt).toBe(0)
        }
    })
})
