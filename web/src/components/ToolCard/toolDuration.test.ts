import { describe, expect, it } from 'vitest'
import type { ChatToolCall } from '@/chat/types'
import { toolDurationMs } from '@/components/ToolCard/toolDuration'

function makeTool(overrides: Partial<ChatToolCall>): ChatToolCall {
    return {
        id: 'tool-1',
        name: 'Bash',
        state: 'completed',
        input: {},
        createdAt: 0,
        startedAt: 0,
        completedAt: 0,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        ...overrides,
    }
}

describe('toolDurationMs', () => {
    it('returns completedAt - startedAt for a completed tool', () => {
        const tool = makeTool({ state: 'completed', startedAt: 100, completedAt: 2600 })
        expect(toolDurationMs(tool)).toBe(2500)
    })

    it('returns a duration for an error tool that has completedAt', () => {
        const tool = makeTool({ state: 'error', startedAt: 100, completedAt: 900 })
        expect(toolDurationMs(tool)).toBe(800)
    })

    it('falls back to createdAt when startedAt is null', () => {
        const tool = makeTool({ state: 'completed', startedAt: null, createdAt: 100, completedAt: 2600 })
        expect(toolDurationMs(tool)).toBe(2500)
    })

    it('returns null while running (completedAt is null)', () => {
        const tool = makeTool({ state: 'running', startedAt: 100, completedAt: null })
        expect(toolDurationMs(tool)).toBeNull()
    })

    it('returns null while pending (no startedAt, no completedAt)', () => {
        const tool = makeTool({ state: 'pending', startedAt: null, completedAt: null })
        expect(toolDurationMs(tool)).toBeNull()
    })

    it('returns null when completedAt precedes startedAt (clock skew, no negative)', () => {
        const tool = makeTool({ state: 'completed', startedAt: 2600, completedAt: 100 })
        expect(toolDurationMs(tool)).toBeNull()
    })

    it('returns 0 for an instantaneous tool (completedAt equals startedAt)', () => {
        const tool = makeTool({ state: 'completed', startedAt: 500, completedAt: 500 })
        expect(toolDurationMs(tool)).toBe(0)
    })

    describe('exec-timestamp (claude entry-side) preference', () => {
        it('prefers execStartedAt/execCompletedAt over the hub-received startedAt/completedAt', () => {
            // hub receipt shows an inflated 2.5s window, but the claude entries
            // themselves (execStartedAt/execCompletedAt) show the true 2.0s.
            const tool = makeTool({
                state: 'completed',
                startedAt: 100,
                completedAt: 2600,
                execStartedAt: 200,
                execCompletedAt: 2200,
            })
            expect(toolDurationMs(tool)).toBe(2000)
        })

        it('falls back to startedAt/completedAt when exec fields are null (non-Claude agent, no regression)', () => {
            const tool = makeTool({
                state: 'completed',
                startedAt: 100,
                completedAt: 2600,
                execStartedAt: null,
                execCompletedAt: null,
            })
            expect(toolDurationMs(tool)).toBe(2500)
        })

        it('uses hub times on BOTH sides when only execStartedAt is present (no mixed-clock subtraction)', () => {
            // Real Claude exec start but a hub-synthesized completion (e.g. a
            // denied/timed-out tool). Mixing 2200 - 200 would fabricate 2000;
            // both-or-neither falls back to the hub pair (2600 - 100 = 2500).
            const tool = makeTool({
                state: 'completed',
                startedAt: 100,
                completedAt: 2600,
                execStartedAt: 200,
                execCompletedAt: null,
            })
            expect(toolDurationMs(tool)).toBe(2500)
        })

        it('uses hub times on BOTH sides when only execCompletedAt is present', () => {
            const tool = makeTool({
                state: 'completed',
                startedAt: 100,
                completedAt: 2600,
                execStartedAt: null,
                execCompletedAt: 2200,
            })
            expect(toolDurationMs(tool)).toBe(2500)
        })

        it('returns null when execCompletedAt precedes execStartedAt (clock skew, no negative)', () => {
            const tool = makeTool({
                state: 'completed',
                startedAt: 100,
                completedAt: 2600,
                execStartedAt: 2200,
                execCompletedAt: 200,
            })
            expect(toolDurationMs(tool)).toBeNull()
        })

        it('returns null while running even if execStartedAt is set (no execCompletedAt yet)', () => {
            const tool = makeTool({ state: 'running', startedAt: 100, execStartedAt: 200, completedAt: null, execCompletedAt: null })
            expect(toolDurationMs(tool)).toBeNull()
        })
    })
})
