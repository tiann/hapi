import { describe, expect, it } from 'vitest'
import {
    decideKeepWrapperArchive,
    decideRawPidStop,
    detachSharedRootFromWrapper,
    keepWrapperForSharedSiblings,
    pidHasActiveSharedRoots,
    sessionRegistryBindingState,
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

    it('keeps recovered shared wrapper when only the new root is tracked (restart + webhook + archive)', () => {
        // Runner restart wiped TrackedSession. A later /new webhook adopts only
        // the newly reported root onto the live shared Codex PID. Older roots
        // remain active solely in the durable registry. Archiving the new root
        // must not fall through to killProcess on that PID.
        const tracked = {
            happySessionId: 'new-root',
            sharedSessions: {
                'new-root': {},
            },
        }
        const runtimesAfterArchive = [
            {
                pid: 4242,
                sessions: {
                    'old-root': { active: true },
                    'new-root': { active: false },
                },
            },
        ]

        // Solo in-memory entry (adoption of the new root only) does not protect the PID:
        expect(trackedSharedWrapperPidsWithSiblings(
            new Map([[4242, { ...tracked, sharedSessions: { ...tracked.sharedSessions } }]]).entries(),
            'new-root'
        ).size).toBe(0)

        // Detach + keepWrapper in-memory path alone would allow killing the wrapper:
        expect(detachSharedRootFromWrapper(tracked, 'new-root')).toEqual({ kind: 'allow_kill' })
        expect(keepWrapperForSharedSiblings(tracked, 'new-root')).toBe(false)

        // Registry siblings on the same PID must keep the wrapper alive:
        expect(wrapperHasActiveSiblingRoots(runtimesAfterArchive, 'new-root', 4242)).toBe(true)
        expect(sessionRuntimeHasActiveSiblings(runtimesAfterArchive, 'new-root')).toBe(true)
        expect(pidHasActiveSharedRoots(runtimesAfterArchive, 4242)).toBe(true)
    })

    it('refuses raw PID kill when the start marker is missing or mismatched', () => {
        expect(decideRawPidStop({
            alive: true,
            expectedMarker: undefined,
            currentMarker: 'gen-a',
            hasActiveSharedRoots: false,
        })).toBe('unknown')
        expect(decideRawPidStop({
            alive: true,
            expectedMarker: 'gen-a',
            currentMarker: 'gen-b',
            hasActiveSharedRoots: false,
        })).toBe('unknown')
        expect(decideRawPidStop({
            alive: true,
            expectedMarker: 'gen-a',
            currentMarker: 'gen-a',
            hasActiveSharedRoots: false,
        })).toBe('allow_kill')
        expect(decideRawPidStop({
            alive: false,
            expectedMarker: 'gen-a',
            currentMarker: null,
            hasActiveSharedRoots: false,
        })).toBe('already_gone')
    })

    it('treats inactive registry binding as stop proof while siblings keep the wrapper', () => {
        expect(sessionRegistryBindingState(runtimes, 'root-a', 4242)).toBe('inactive')
        expect(sessionRegistryBindingState(runtimes, 'root-b', 4242)).toBe('active')
        expect(sessionRegistryBindingState(runtimes, 'missing', 4242)).toBe('absent')
        expect(decideKeepWrapperArchive('inactive')).toBe('stopped')
        expect(decideKeepWrapperArchive('active')).toBe('still_alive')
        expect(decideKeepWrapperArchive('absent')).toBe('unknown')
    })

    it('does not claim stopped from siblings alone on retry (no binding evidence)', () => {
        // First StopSession detached in-memory tracking and returned unknown.
        // Retry: argv scan skips the sibling-protected wrapper; without an
        // inactive registry row we must stay unknown — not archive the live root.
        const siblingsOnly = [
            {
                pid: 4242,
                sessions: {
                    // Target never made it into the durable registry (or was
                    // never written). Sibling is still active.
                    'root-sibling': { active: true },
                },
            },
        ]
        expect(wrapperHasActiveSiblingRoots(siblingsOnly, 'root-unconfirmed', 4242)).toBe(true)
        expect(sessionRegistryBindingState(siblingsOnly, 'root-unconfirmed')).toBe('absent')
        expect(decideKeepWrapperArchive(
            sessionRegistryBindingState(siblingsOnly, 'root-unconfirmed')
        )).toBe('unknown')
    })
})
