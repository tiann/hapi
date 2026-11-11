import { describe, expect, it } from 'vitest'
import { buildChildExitNotices } from './childExitNotice'

describe('buildChildExitNotices', () => {
    it('reports every HAPI root owned by one runner child exactly once', () => {
        const notices = buildChildExitNotices({
            pid: 4321,
            processStartMarker: 'Mon Jan  1 00:00:00 2024',
            tracked: {
                requestedHappySessionId: 'requested',
                happySessionId: 'happy',
                sharedSessions: {
                    happy: {},
                    sibling: {}
                }
            },
            requestedSessionId: 'requested',
            confirmedSessionId: 'happy',
            existingSessionId: 'sibling'
        }, {
            time: 1_700_000_000_000,
            intentional: false
        })

        expect(notices.map((notice) => notice.sid).sort()).toEqual([
            'happy',
            'requested',
            'sibling'
        ])
        expect(notices.every((notice) => notice.pid === 4321)).toBe(true)
        expect(notices.every((notice) => notice.processStartMarker === 'Mon Jan  1 00:00:00 2024')).toBe(true)
    })

    it('falls back to the generation reported by the session webhook', () => {
        const notices = buildChildExitNotices({
            pid: 7,
            tracked: {
                sharedSessions: {},
                happySessionMetadataFromLocalWebhook: {
                    hostStartMarker: 'webhook-marker'
                }
            },
            confirmedSessionId: 'confirmed'
        }, { time: 1, intentional: false })

        expect(notices).toEqual([{
            sid: 'confirmed',
            pid: 7,
            processStartMarker: 'webhook-marker'
        }])
    })

    it('does not report an intentional runner stop as an unexpected exit', () => {
        expect(buildChildExitNotices({
            pid: 9,
            processStartMarker: 'marker',
            tracked: { happySessionId: 'archived' },
            confirmedSessionId: 'archived'
        }, { time: 1, intentional: true })).toEqual([])
    })

    it('returns no notice when the child never reported a HAPI session', () => {
        expect(buildChildExitNotices({
            pid: 10,
            processStartMarker: 'marker',
            tracked: { sharedSessions: {} }
        }, { time: 2, intentional: false })).toEqual([])
    })
})
