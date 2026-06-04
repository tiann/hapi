import { describe, expect, it } from 'vitest'
import {
    buildGoalStateMessages,
    shouldAutoClearPendingSchedule,
    shouldRouteToScratchlist,
} from './SessionChat'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'

function userMessage(props: {
    id: string
    createdAt: number
    localId?: string | null
    invokedAt?: number | null
    scheduledAt?: number | null
}): DecryptedMessage {
    return {
        id: props.id,
        seq: null,
        localId: props.localId ?? null,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: 'hello'
            }
        },
        createdAt: props.createdAt,
        invokedAt: props.invokedAt,
        scheduledAt: props.scheduledAt
    }
}

/**
 * Unit tests for shouldAutoClearPendingSchedule.
 *
 * The useEffect in SessionChat auto-clears only 'absolute' pending schedules
 * when the chosen time expires.  'preset' schedules must NOT be auto-cleared
 * because they are relative to send time and have no fixed expiry.
 *
 * This test guards against future refactors that accidentally break the
 * preset-stays-alive invariant (a silent break: the effect would cancel the
 * preset with no user-visible error before send time).
 */
describe('shouldAutoClearPendingSchedule', () => {
    it('returns false for null (no schedule set)', () => {
        expect(shouldAutoClearPendingSchedule(null)).toBe(false)
    })

    it('returns false for preset schedule — presets do not expire before send', () => {
        const preset: PendingSchedule = { type: 'preset', preset: '+5m' }
        expect(shouldAutoClearPendingSchedule(preset)).toBe(false)
    })

    it('returns false for all preset values', () => {
        const presets: Array<'+5m' | '+30m' | '+1h' | '+4h'> = ['+5m', '+30m', '+1h', '+4h']
        for (const p of presets) {
            const pending: PendingSchedule = { type: 'preset', preset: p }
            expect(shouldAutoClearPendingSchedule(pending)).toBe(false)
        }
    })

    it('returns true for absolute schedule — absolute schedules have a fixed expiry instant', () => {
        const absolute: PendingSchedule = { type: 'absolute', ms: Date.now() + 60_000 }
        expect(shouldAutoClearPendingSchedule(absolute)).toBe(true)
    })

    it('returns true for expired absolute schedule (ms in the past)', () => {
        const expired: PendingSchedule = { type: 'absolute', ms: Date.now() - 1000 }
        expect(shouldAutoClearPendingSchedule(expired)).toBe(true)
    })
})

/**
 * Unit tests for shouldRouteToScratchlist.
 *
 * Regression cover for upstream review on PR #798 (github-actions[bot]
 * [Major]): scratchlist-mode submissions used to silently drop
 * attachments and scheduledAt because the wrapper short-circuited to
 * scratchlist.add(text) regardless of payload. The fix is to fall
 * through to the regular chat send whenever the submission can't be
 * represented as a pure-text scratchlist entry.
 */
describe('shouldRouteToScratchlist', () => {
    function attachment(): AttachmentMetadata {
        return {
            id: 'attach-1',
            kind: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
        } as AttachmentMetadata
    }

    it('returns false when scratchlist mode is off, regardless of payload', () => {
        expect(shouldRouteToScratchlist(false, undefined, null)).toBe(false)
        expect(shouldRouteToScratchlist(false, [attachment()], null)).toBe(false)
        expect(shouldRouteToScratchlist(false, undefined, Date.now() + 60_000)).toBe(false)
    })

    it('returns true when scratchlist mode is on and the payload is pure text', () => {
        expect(shouldRouteToScratchlist(true, undefined, null)).toBe(true)
        expect(shouldRouteToScratchlist(true, undefined, undefined)).toBe(true)
        expect(shouldRouteToScratchlist(true, [], null)).toBe(true)
    })

    it('returns false when scratchlist mode is on but attachments are present', () => {
        expect(shouldRouteToScratchlist(true, [attachment()], null)).toBe(false)
        expect(shouldRouteToScratchlist(true, [attachment(), attachment()], null)).toBe(false)
    })

    it('returns false when scratchlist mode is on but a scheduled-send is set', () => {
        expect(shouldRouteToScratchlist(true, undefined, Date.now() + 60_000)).toBe(false)
        expect(shouldRouteToScratchlist(true, [], 0)).toBe(false)
    })

    it('returns false when both attachments and scheduledAt are set', () => {
        expect(shouldRouteToScratchlist(true, [attachment()], Date.now() + 60_000)).toBe(false)
    })
})

describe('buildGoalStateMessages', () => {
    it('keeps immediate queued user messages so completed goal status can clear before timeline render', () => {
        const now = 1_700_000_000_000
        const messages = [
            userMessage({
                id: 'local-immediate',
                localId: 'local-immediate',
                createdAt: now,
                invokedAt: null
            })
        ]

        expect(buildGoalStateMessages(messages).map((message) => message.id))
            .toEqual(['local-immediate'])
    })

    it('includes pending messages that are outside the visible timeline window', () => {
        const now = 1_700_000_000_000
        const visible = [
            userMessage({ id: 'visible', createdAt: now - 10 })
        ]
        const pending = [
            userMessage({ id: 'pending', createdAt: now })
        ]

        expect(buildGoalStateMessages(visible, pending).map((message) => message.id))
            .toEqual(['visible', 'pending'])
    })

    it('ignores uninvoked scheduled messages, including mature prompts, until they are invoked', () => {
        const now = 1_700_000_000_000
        const futureQueued = userMessage({
            id: 'future',
            createdAt: now,
            invokedAt: null,
            scheduledAt: now + 60_000
        })
        const matureQueued = userMessage({
            id: 'mature',
            createdAt: now + 1,
            invokedAt: null,
            scheduledAt: now - 60_000
        })
        const invokedScheduled = userMessage({
            id: 'invoked',
            createdAt: now + 2,
            invokedAt: now + 30_000,
            scheduledAt: now - 60_000
        })

        expect(buildGoalStateMessages([futureQueued, matureQueued, invokedScheduled]).map((message) => message.id))
            .toEqual(['invoked'])
    })
})
