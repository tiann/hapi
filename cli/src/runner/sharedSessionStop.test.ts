import { describe, expect, it } from 'vitest'
import {
    detachSharedRootFromWrapper,
    keepWrapperForSharedSiblings,
    sessionRuntimeHasActiveSiblings,
    trackedSharedWrapperPidsWithSiblings,
    wrapperHasActiveSiblingRoots,
} from './sharedSessionStop'

describe('detachSharedRootFromWrapper', () => {
    it('keeps the wrapper when sibling shared roots remain', () => {
        const session = {
            happySessionId: 'root-a',
            sharedSessions: {
                'root-a': {},
                'root-b': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-a')).toEqual({ kind: 'keep_wrapper' })
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })

    it('keeps the wrapper when primary is a different live root', () => {
        const session = {
            happySessionId: 'root-primary',
            sharedSessions: {
                'root-archived': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-archived')).toEqual({ kind: 'keep_wrapper' })
        expect(session.sharedSessions).toBeUndefined()
    })

    it('allows kill when the last shared root is the primary being stopped', () => {
        const session = {
            happySessionId: 'root-only',
            sharedSessions: {
                'root-only': {},
            },
        }
        expect(detachSharedRootFromWrapper(session, 'root-only')).toEqual({ kind: 'allow_kill' })
        expect(session.sharedSessions).toBeUndefined()
    })

    it('allows kill when session id is not in sharedSessions', () => {
        const session = {
            happySessionId: 'root-a',
            sharedSessions: { 'root-b': {} },
        }
        expect(detachSharedRootFromWrapper(session, 'root-missing')).toEqual({ kind: 'allow_kill' })
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })
})

describe('keepWrapperForSharedSiblings', () => {
    it('returns true and drops the archived root when siblings remain', () => {
        const session = {
            sharedSessions: {
                'root-a': {},
                'root-b': {},
            },
        }
        expect(keepWrapperForSharedSiblings(session, 'root-a')).toBe(true)
        expect(session.sharedSessions).toEqual({ 'root-b': {} })
    })

    it('returns false when no siblings remain', () => {
        const session = {
            sharedSessions: { 'root-a': {} },
        }
        expect(keepWrapperForSharedSiblings(session, 'root-a')).toBe(false)
        expect(session.sharedSessions).toEqual({ 'root-a': {} })
    })
})

describe('runtime registry sibling guards (post-restart)', () => {
    const runtimes = [
        {
            pid: 4242,
            sessions: {
                'root-a': { active: false },
                'root-b': { active: true },
            },
        },
    ]

    it('keeps the wrapper when archiving the original root after tracking loss', () => {
        // KillSession / stopSession already marked root-a inactive; TrackedSession
        // is gone after runner restart — persisted-PID and argv paths must not kill.
        expect(sessionRuntimeHasActiveSiblings(runtimes, 'root-a')).toBe(true)
        expect(wrapperHasActiveSiblingRoots(runtimes, 'root-a', 4242)).toBe(true)
    })

    it('allows kill when no other root is active on the wrapper', () => {
        const lastRoot = [
            {
                pid: 4242,
                sessions: {
                    'root-a': { active: false },
                    'root-b': { active: false },
                },
            },
        ]
        expect(sessionRuntimeHasActiveSiblings(lastRoot, 'root-a')).toBe(false)
        expect(wrapperHasActiveSiblingRoots(lastRoot, 'root-a', 4242)).toBe(false)
    })

    it('ignores unrelated wrapper PIDs', () => {
        expect(wrapperHasActiveSiblingRoots(runtimes, 'root-a', 9999)).toBe(false)
    })

    it('PID-filters shared wrappers while leaving other orphan PIDs killable', () => {
        // Older untracked CLI (9999) and current shared wrapper (4242) both
        // match the same HAPI session id. Session-wide sibling presence must
        // not skip the argv scan — only the wrapper PID is excluded.
        const orphanPids = [4242, 9999]
        const filtered = orphanPids.filter(
            (pid) => !wrapperHasActiveSiblingRoots(runtimes, 'root-a', pid)
        )
        expect(filtered).toEqual([9999])
        expect(sessionRuntimeHasActiveSiblings(runtimes, 'root-a')).toBe(true)
    })

    it('protects tracked shared wrappers when the runtime registry is empty', () => {
        const tracked = new Map([
            [4242, {
                happySessionId: 'root-a',
                sharedSessions: {
                    'root-a': {},
                    'root-b': {},
                },
            }],
        ])
        const protectedPids = trackedSharedWrapperPidsWithSiblings(tracked.entries(), 'root-a')
        expect([...protectedPids]).toEqual([4242])

        // Registry unavailable: empty runtimes must not leave the tracked wrapper killable.
        const orphanPids = [4242, 9999]
        const filtered = orphanPids.filter((pid) => (
            !protectedPids.has(pid)
            && !wrapperHasActiveSiblingRoots([], 'root-a', pid)
        ))
        expect(filtered).toEqual([9999])
    })
})
