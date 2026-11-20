import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { BLOCKED_NOTIFY_STALE_MS } from '@hapi/protocol'
import {
    classifySessionAttention,
    getSessionBlockedState,
    sessionBlockedIsError,
    sessionIsUnread,
} from './sessionAttention'
import { followSessionTail } from './sessionLastSeen'

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 999_999,
        contentRevision: 1000,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('classifySessionAttention', () => {
    it('keeps permission attention on the selected session', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', pendingRequestKinds: ['permission'] }),
            { selected: true, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('shows an explicitly marked unread dot for the selected session', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('keeps an explicitly marked unread dot while the selected session is thinking', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', thinking: true, contentRevision: 5000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('keeps unread content while the selected session is reading history', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: true, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('carries an explicit unread dot across newer activity', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 6000 }),
            { selected: true, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('prioritizes permission over unread activity', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'permission' })
    })

    it('ignores pending requests left on an archived session', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                active: false,
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 5000 }
        )
        expect(attention).toBeNull()
    })

    it('handles summaries from older APIs without pendingRequestKinds', () => {
        const legacySummary = makeSummary({ id: 'legacy', contentRevision: 5000 }) as unknown as SessionSummary
        delete (legacySummary as Partial<SessionSummary>).pendingRequestKinds

        const attention = classifySessionAttention(
            legacySummary,
            { selected: false, lastSeenAt: 1000 }
        )

        expect(attention).toEqual({ kind: 'unread' })
    })

    it('shows unread activity when the session has updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('shows unseen output while the session is thinking', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'generating', thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )).toEqual({ kind: 'unread' })
    })

    it('does not flash ordinary unread for a chat following its tail', () => {
        const summary = makeSummary({ id: 'followed', thinking: true, contentRevision: 5000 })
        const release = followSessionTail(summary.id)
        try {
            expect(classifySessionAttention(summary, { selected: true, lastSeenAt: 1000 })).toBeNull()
            expect(classifySessionAttention(summary, { selected: true, lastSeenAt: 1000, manualUnreadAt: 0 }))
                .toEqual({ kind: 'unread' })
        } finally {
            release()
        }
        expect(classifySessionAttention(summary, { selected: true, lastSeenAt: 1000 })).toEqual({ kind: 'unread' })
    })

    it('keeps an explicitly marked unread dot while a session is thinking', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'manual-thinking', thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 5000, manualUnreadAt: 5000 }
        )).toEqual({ kind: 'unread' })
    })

    it('treats inactive stale thinking as unread activity', () => {
        expect(classifySessionAttention(
            makeSummary({ id: 'expired-thinking', active: false, thinking: true, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )).toEqual({ kind: 'unread' })
    })

    it('shows background work when no output is unseen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', backgroundTaskCount: 2, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 5000 }
        )
        expect(attention).toEqual({ kind: 'background' })
    })

    it('prefers unseen output over background work', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', backgroundTaskCount: 2, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 0 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('shows unread activity for inactive sessions updated since last seen', () => {
        const attention = classifySessionAttention(
            makeSummary({ id: 'a', active: false, contentRevision: 5000 }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })

    it('prefers unread over background for inactive sessions', () => {
        const attention = classifySessionAttention(
            makeSummary({
                id: 'a',
                active: false,
                backgroundTaskCount: 2,
                contentRevision: 5000
            }),
            { selected: false, lastSeenAt: 1000 }
        )
        expect(attention).toEqual({ kind: 'unread' })
    })
})

describe('sessionIsUnread', () => {
    it('is true when contentRevision is newer than the read revision', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'u', contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('is false when the operator has already seen this update', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'seen', contentRevision: 1000 }),
            { lastSeenAt: 5000 }
        )).toBe(false)
    })

    it('is true for output received while the session is thinking', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'generating', thinking: true, contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('allows unread activity from an inactive session with a stale thinking flag', () => {
        expect(sessionIsUnread(
            makeSummary({ id: 'expired-thinking', active: false, thinking: true, contentRevision: 5000 }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })

    it('does not care about permission / background fields — only the watermark', () => {
        expect(sessionIsUnread(
            makeSummary({
                id: 'p',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                contentRevision: 1000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(false)

        expect(sessionIsUnread(
            makeSummary({
                id: 'bg',
                backgroundTaskCount: 3,
                contentRevision: 9000,
            }),
            { lastSeenAt: 1000 }
        )).toBe(true)
    })
})

describe('getSessionBlockedState', () => {
    const now = 5_000_000

    it('flags a blocked footer and carries its note', () => {
        const state = getSessionBlockedState(
            makeSummary({ id: 'a', lastNotify: { status: 'blocked', at: now, note: 'needs a token' } }),
            { now }
        )
        expect(state).toEqual({
            key: `notify:${now}`, reason: 'blocked', at: now, note: 'needs a token', stale: false
        })
    })

    it('treats a self-reported stall as blocked, matching the hub work_ad fold', () => {
        const state = getSessionBlockedState(
            makeSummary({ id: 'a', lastNotify: { status: 'stalled', at: now, note: null } }),
            { now }
        )
        expect(state?.reason).toBe('stalled')
    })

    it('treats a pending permission request as blocked', () => {
        // Operator's rule: a session parked on a prompt cannot proceed without
        // them, so it belongs in the same count and section as a self-reported
        // blocked footer.
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                pendingRequestsCount: 1,
                pendingRequestKinds: ['permission'],
                pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now - 1000 }]
            }),
            { now }
        )
        expect(state).toEqual({
            key: 'request:r1', reason: 'permission', at: now - 1000, note: 'Bash', stale: false
        })
    })

    it('treats a Cursor plan approval as a question, not a bare permission', () => {
        // CursorCreatePlan is Cursor's ExitPlanMode; it was misclassified as a
        // plain permission before, so every Cursor plan review read as "approve
        // a tool" rather than "answer me".
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                pendingRequestsCount: 1,
                pendingRequestKinds: ['input'],
                pendingRequests: [{ id: 'r1', kind: 'input', tool: 'CursorCreatePlan', since: now }]
            }),
            { now }
        )
        expect(state?.reason).toBe('question')
    })

    it('ranks an unanswered question above a permission on the same session', () => {
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                pendingRequestsCount: 2,
                pendingRequestKinds: ['permission', 'input'],
                pendingRequests: [
                    { id: 'r1', kind: 'permission', tool: 'Bash', since: now - 5000 },
                    { id: 'r2', kind: 'input', tool: 'AskUserQuestion', since: now }
                ]
            }),
            { now }
        )
        expect(state?.reason).toBe('question')
        expect(state?.note).toBe('AskUserQuestion')
    })

    it('treats a pending input request as blocked', () => {
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                pendingRequestsCount: 1,
                pendingRequestKinds: ['input'],
                pendingRequests: [{ id: 'r1', kind: 'input', tool: 'AskUserQuestion', since: now }]
            }),
            { now }
        )
        expect(state?.reason).toBe('question')
    })

    it('still counts a pending request whose kinds did not survive the summary', () => {
        const state = getSessionBlockedState(
            makeSummary({ id: 'a', pendingRequestsCount: 2, pendingRequestKinds: [] }),
            { now }
        )
        expect(state?.reason).toBe('permission')
    })

    it('prefers the live prompt over a stored footer', () => {
        // The prompt is the thing one click clears.
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                lastNotify: { status: 'blocked', at: now, note: 'older reason' },
                pendingRequestsCount: 1,
                pendingRequestKinds: ['permission'],
                pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Edit', since: now }]
            }),
            { now }
        )
        expect(state?.reason).toBe('permission')
        expect(state?.note).toBe('Edit')
    })

    it('flags every status class the operator calls a blocker', () => {
        const cases: Array<[string, string]> = [
            ['blocked', 'blocked'],
            ['stalled', 'stalled'],
            ['needs_decision', 'needs_decision'],
            ['needs_review', 'needs_review'],
            ['failed', 'failed'],
            ['error', 'failed'],
            // Non-contract but the most-emitted waiting status in the wild.
            ['pending', 'blocked'],
            ['waiting', 'blocked'],
            ['BLOCKED', 'blocked'],
        ]
        for (const [status, reason] of cases) {
            const state = getSessionBlockedState(
                makeSummary({ id: 'a', lastNotify: { status, at: now, note: null } }),
                { now }
            )
            expect([status, state?.reason]).toEqual([status, reason])
        }
    })

    it('leaves finished and running agents alone', () => {
        // `completed` is non-contract but observed; it must clear, not alarm.
        for (const status of ['done', 'completed', 'complete', 'in_progress', 'running', 'success']) {
            expect(getSessionBlockedState(
                makeSummary({ id: 'a', lastNotify: { status, at: now, note: null } }),
                { now }
            )).toBeNull()
        }
    })

    it('does not alarm on an unrecognised status', () => {
        // Default must be quiet — crying wolf costs more than a missed synonym.
        expect(getSessionBlockedState(
            makeSummary({ id: 'a', lastNotify: { status: 'refactoring', at: now, note: null } }),
            { now }
        )).toBeNull()
    })

    it('marks only errors as error-styled', () => {
        const failed = getSessionBlockedState(
            makeSummary({ id: 'a', lastNotify: { status: 'failed', at: now, note: null } }),
            { now }
        )!
        const blocked = getSessionBlockedState(
            makeSummary({ id: 'b', lastNotify: { status: 'blocked', at: now, note: null } }),
            { now }
        )!
        expect(sessionBlockedIsError(failed)).toBe(true)
        expect(sessionBlockedIsError(blocked)).toBe(false)
    })

    it('suppresses a stored footer while the agent is thinking again', () => {
        // The hub clears lastNotify on the same transition; this guards the
        // window before that patch lands.
        expect(getSessionBlockedState(
            makeSummary({ id: 'a', thinking: true, lastNotify: { status: 'blocked', at: now, note: null } }),
            { now }
        )).toBeNull()
    })

    it('still blocks on a live prompt while the agent is thinking', () => {
        // A remote Claude agent keeps `thinking` true for the whole wait: the
        // SDK only clears it on the turn's result, and the permission handler
        // never touches it. Suppressing here hid the commonest blocker there
        // is — an agent parked on a permission — for as long as it waited.
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                thinking: true,
                pendingRequestsCount: 1,
                pendingRequestKinds: ['permission'],
                pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now }]
            }),
            { now }
        )
        expect(state?.reason).toBe('permission')
    })

    it('marks a report older than the loud window stale rather than dropping it', () => {
        const state = getSessionBlockedState(
            makeSummary({ id: 'a', lastNotify: { status: 'blocked', at: now - BLOCKED_NOTIFY_STALE_MS - 1, note: null } }),
            { now }
        )
        expect(state?.stale).toBe(true)
    })

    it('ages a long-unanswered prompt the same way', () => {
        const state = getSessionBlockedState(
            makeSummary({
                id: 'a',
                pendingRequestsCount: 1,
                pendingRequestKinds: ['permission'],
                pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now - BLOCKED_NOTIFY_STALE_MS - 1 }]
            }),
            { now }
        )
        expect(state?.stale).toBe(true)
    })

    it('honours a manual unblock, and lets a NEWER blocker come back', () => {
        // Watermark, not a flag: dismissing must not mute the session forever.
        const acked = makeSummary({
            id: 'a',
            lastNotify: { status: 'blocked', at: now - 1000, note: 'old' },
            blockedAck: { at: now, reason: 'handled outside HAPI' }
        })
        expect(getSessionBlockedState(acked, { now })).toBeNull()

        const reblocked = makeSummary({
            ...acked,
            id: 'a',
            lastNotify: { status: 'blocked', at: now + 1, note: 'new problem' }
        })
        expect(getSessionBlockedState(reblocked, { now })?.reason).toBe('blocked')
    })

    it('dismisses a stale prompt but not one raised after the acknowledgement', () => {
        const base = {
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission' as const],
            blockedAck: { at: now, reason: 'abandoned' }
        }
        expect(getSessionBlockedState(makeSummary({
            id: 'a',
            ...base,
            pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now - 5000 }]
        }), { now })).toBeNull()

        expect(getSessionBlockedState(makeSummary({
            id: 'a',
            ...base,
            pendingRequests: [{ id: 'r2', kind: 'permission', tool: 'Bash', since: now + 5000 }]
        }), { now })?.reason).toBe('permission')
    })

    it('still reports a newer footer when the prompt was acknowledged', () => {
        // Dismissing a prompt says nothing about a later self-reported blocker
        // on the same session; returning early there would silently mute it.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now - 5000 }],
            lastNotify: { status: 'failed', at: now + 100, note: 'blew up after' },
            blockedAck: { at: now, reason: 'approved out of band' }
        }), { now })

        expect(state?.reason).toBe('failed')
    })

    it('blocks on a new prompt while an older acknowledged one is still open', () => {
        // Comparing only the oldest request would keep the session suppressed.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['permission'],
            pendingRequests: [
                { id: 'r1', kind: 'permission', tool: 'Bash', since: now - 5000 },
                { id: 'r2', kind: 'permission', tool: 'Edit', since: now + 5000 }
            ],
            blockedAck: { at: now, reason: 'dismissed the first one' }
        }), { now })

        expect(state?.reason).toBe('permission')
        expect(state?.note).toBe('Edit')
    })

    it('blocks on a new permission when an acknowledged question outranks it', () => {
        // Kind priority ran before the acknowledgement filter, so 'question'
        // won, the matching pool held only the dismissed input request, and the
        // genuinely unanswered permission was discarded entirely.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['input', 'permission'],
            pendingRequests: [
                { id: 'r1', kind: 'input', tool: 'AskUserQuestion', since: now - 5000 },
                { id: 'r2', kind: 'permission', tool: 'Bash', since: now + 5000 }
            ],
            blockedAck: { at: now, reason: 'answered the question elsewhere' }
        }), { now })

        expect(state?.reason).toBe('permission')
        expect(state?.note).toBe('Bash')
    })

    it('blocks on a prompt that arrived beyond the capped summary slice', () => {
        // `pendingRequests` keeps the 5 OLDEST. With all five acknowledged, a
        // sixth prompt is absent from the slice, so the capped view alone
        // cannot tell "all answered" from "the new one is not shown".
        const capped = Array.from({ length: 5 }, (_, index) => ({
            id: `r${index}`,
            kind: 'permission' as const,
            tool: 'Bash',
            since: now - 5000 + index
        }))
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 6,
            pendingRequestKinds: ['permission'],
            pendingRequests: capped,
            pendingRequestsNewestAt: now + 5000,
            blockedAck: { at: now, reason: 'cleared the visible ones' }
        }), { now })

        expect(state?.reason).toBe('permission')
    })

    it('stays clear when the uncapped watermark predates the acknowledgement', () => {
        const capped = Array.from({ length: 5 }, (_, index) => ({
            id: `r${index}`,
            kind: 'permission' as const,
            tool: 'Bash',
            since: now - 5000 + index
        }))
        expect(getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 6,
            pendingRequestKinds: ['permission'],
            pendingRequests: capped,
            pendingRequestsNewestAt: now - 1000,
            blockedAck: { at: now, reason: 'handled them all' }
        }), { now })).toBeNull()
    })

    it('ignores a prompt left on an archived session', () => {
        // `handleSessionEnd` drops activity but keeps `agentState.requests`, so
        // without this the row sits in Blocked forever on a prompt nobody can
        // answer. Matches `classifySessionAttention`.
        expect(getSessionBlockedState(makeSummary({
            id: 'a',
            active: false,
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: now }]
        }), { now })).toBeNull()
    })

    it('still reports a notify footer on an archived session', () => {
        // The footer stands on its own: the agent said it was stuck before the
        // session ended, and that is still true.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            active: false,
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            lastNotify: { status: 'blocked', at: now, note: 'needs a decision' }
        }), { now })
        expect(state?.reason).toBe('blocked')
    })

    it('does not label an overflow prompt with a dismissed question\'s kind', () => {
        // The visible slice is a question the operator dismissed; the live
        // blocker is an overflow prompt whose kind the summary does not carry.
        // `pendingRequestKinds` is a deduped set over ALL prompts, so reading
        // the label off it reported "Question" — borrowed wholesale from the
        // prompt that was already dealt with.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['permission', 'input'],
            pendingRequests: [{ id: 'r1', kind: 'input', tool: 'AskUser', since: now - 2000 }],
            pendingRequestRefs: [
                { id: 'r1', kind: 'input', since: now - 2000 },
                { id: 'r2', kind: 'permission', since: now - 1000 }
            ],
            pendingRequestsNewestAt: now - 1000,
            blockedAck: { at: now, reason: 'answered that one', keys: ['request:r1'] }
        }), { now })

        // Still blocked — the overflow prompt is real and unanswered — and
        // acknowledging it has to target the overflow prompt, not the
        // dismissed one.
        expect(state?.key).toBe('request:r2')
        expect(state?.reason).toBe('permission')
        // The age must be the chosen prompt's own, not the newest across all.
        expect(state?.at).toBe(now - 1000)
    })

    it('labels an overflow question as a question, with its own age', () => {
        // The reviewer's case, and the one a neutral default still got wrong:
        // five dismissed previews and a sixth, unanswered QUESTION. The chip,
        // the dismissal target and the age must all describe that question —
        // previously the id came from the overflow list while the label came
        // from aggregate kinds and the age from the newest timestamp across
        // every prompt, so all three could describe different requests.
        const previews = [1, 2, 3, 4, 5].map((n) => ({
            id: `p${n}`,
            kind: 'permission' as const,
            tool: 'Bash',
            since: now - 10_000 + n
        }))
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 6,
            pendingRequestKinds: ['permission', 'input'],
            pendingRequests: previews,
            pendingRequestRefs: [
                ...previews.map(({ id, kind, since }) => ({ id, kind, since })),
                { id: 'q6', kind: 'input', since: now - 3000 },
                // A NEWER prompt that was also dismissed. It owns the
                // aggregate `pendingRequestsNewestAt`, so any age taken from
                // that field describes this prompt rather than the live one.
                { id: 'p7', kind: 'permission', since: now - 500 }
            ],
            pendingRequestsNewestAt: now - 500,
            blockedAck: {
                at: now,
                reason: 'approved those',
                keys: [...previews.map((request) => `request:${request.id}`), 'request:p7']
            }
        }), { now })

        expect(state?.key).toBe('request:q6')
        expect(state?.reason).toBe('question')
        expect(state?.at).toBe(now - 3000)
    })

    it('prefers a question over a permission among several live prompts', () => {
        // Positive control that the contest still runs over the descriptors:
        // a question outranks a permission even when the permission is older.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 2,
            pendingRequestKinds: ['permission', 'input'],
            pendingRequests: [
                { id: 'perm', kind: 'permission', tool: 'Bash', since: now - 9000 },
                { id: 'ask', kind: 'input', tool: 'AskUser', since: now - 4000 }
            ],
            pendingRequestRefs: [
                { id: 'perm', kind: 'permission', since: now - 9000 },
                { id: 'ask', kind: 'input', since: now - 4000 }
            ]
        }), { now })

        expect(state?.reason).toBe('question')
        expect(state?.key).toBe('request:ask')
        expect(state?.at).toBe(now - 4000)
    })

    it('still reads the kind list when the hub sent no prompt array at all', () => {
        // Positive control for the fallback the fix had to preserve: an older
        // hub reports a count and kinds with no `pendingRequests`, where
        // nothing visible could have been dismissed, so the kind list is the
        // only evidence there is and must still be honoured.
        const state = getSessionBlockedState(makeSummary({
            id: 'a',
            pendingRequestsCount: 1,
            pendingRequestKinds: ['input'],
            pendingRequests: []
        }), { now })

        expect(state?.reason).toBe('question')
    })

    it('returns null when nothing is blocking', () => {
        expect(getSessionBlockedState(makeSummary({ id: 'a' }), { now })).toBeNull()
    })
})
