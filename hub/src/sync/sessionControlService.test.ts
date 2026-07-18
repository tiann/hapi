import { describe, expect, it } from 'bun:test'
import {
    acquireRunnerControl,
    initializeDesktopMirrorControl,
    releaseRunnerControl,
    shouldAcceptPassiveSync
} from './sessionControlService'

describe('sessionControlService', () => {
    it('initializes desktop mirror control on first passive sync', () => {
        const control = initializeDesktopMirrorControl(1_700_000_000_000)

        expect(control).toEqual({
            owner: 'desktop-sync',
            generation: 1,
            leaseExpiresAt: null,
            runnerSessionId: null,
            updatedAt: 1_700_000_000_000
        })
    })

    it('accepts null control on first passive sync and initializes desktop mirror ownership', () => {
        const now = 1_700_000_000_000

        expect(shouldAcceptPassiveSync(null, undefined, now)).toEqual({
            accepted: true,
            nextControl: initializeDesktopMirrorControl(now)
        })
    })

    it('moves control to hapi-runner and bumps generation', () => {
        const desktop = initializeDesktopMirrorControl(10)
        const runner = acquireRunnerControl(desktop, 'session-runner', 110, 60_000)

        expect(runner).toEqual({
            owner: 'hapi-runner',
            generation: 2,
            leaseExpiresAt: 60_110,
            runnerSessionId: 'session-runner',
            updatedAt: 110
        })
    })

    it('accepts matching passive sync generations after takeover but rejects stale ones', () => {
        const desktop = initializeDesktopMirrorControl(10)
        const runner = acquireRunnerControl(desktop, 'session-runner', 110, 60_000)

        expect(shouldAcceptPassiveSync(runner, 1, 120).accepted).toBe(false)
        expect(shouldAcceptPassiveSync(runner, 2, 120)).toEqual({
            accepted: true,
            nextControl: runner
        })
    })

    it('rejects generation mismatches after runner lease expiry', () => {
        const desktop = initializeDesktopMirrorControl(10)
        const runner = acquireRunnerControl(desktop, 'session-runner', 110, 60_000)

        expect(shouldAcceptPassiveSync(runner, 999, 60_111).accepted).toBe(false)
    })

    it('accepts passive sync while preserving desktop ownership', () => {
        const desktop = initializeDesktopMirrorControl(10)

        expect(shouldAcceptPassiveSync(desktop, 1, 120)).toEqual({
            accepted: true,
            nextControl: desktop
        })
    })

    it('accepts passive sync and releases expired runner ownership', () => {
        const desktop = initializeDesktopMirrorControl(10)
        const runner = acquireRunnerControl(desktop, 'session-runner', 110, 60_000)

        expect(shouldAcceptPassiveSync(runner, 2, 60_111)).toEqual({
            accepted: true,
            nextControl: {
                owner: 'desktop-sync',
                generation: 3,
                leaseExpiresAt: null,
                runnerSessionId: null,
                updatedAt: 60_111
            }
        })
    })

    it('returns control to desktop sync on release and bumps generation again', () => {
        const desktop = initializeDesktopMirrorControl(10)
        const runner = acquireRunnerControl(desktop, 'session-runner', 110, 60_000)
        const released = releaseRunnerControl(runner, 220)

        expect(released).toEqual({
            owner: 'desktop-sync',
            generation: 3,
            leaseExpiresAt: null,
            runnerSessionId: null,
            updatedAt: 220
        })
    })
})
