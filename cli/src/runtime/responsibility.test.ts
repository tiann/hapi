import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureLauncherPid, getLauncherPid, LAUNCHER_PID_ENV } from './launcherPid'
import { ownsResponsibility } from './responsibility'

// pid -> responsible pid
function table(entries: Record<number, number>): (pid: number) => number {
    return (pid) => entries[pid] ?? pid
}

describe('ownsResponsibility', () => {
    it('is true for a process that is its own responsible process (started by launchd)', () => {
        expect(ownsResponsibility({ pid: 100, ppid: 1, launcherPid: null, responsibleFor: table({ 100: 100 }) })).toBe(true)
    })

    it('is true under the npm launcher when that launcher is the parent and its own responsible process', () => {
        expect(ownsResponsibility({ pid: 100, ppid: 50, launcherPid: 50, responsibleFor: table({ 100: 50, 50: 50 }) })).toBe(true)
    })

    it('is false under the npm launcher started from Terminal or SSH', () => {
        // Terminal (10) is responsible for both the launcher (50) and the binary (100).
        expect(ownsResponsibility({ pid: 100, ppid: 50, launcherPid: 50, responsibleFor: table({ 100: 10, 50: 10 }) })).toBe(false)
    })

    it('is false when the responsible process is not the declared launcher or not the parent', () => {
        const facts = { pid: 100, responsibleFor: table({ 100: 50, 50: 50 }) }
        expect(ownsResponsibility({ ...facts, ppid: 50, launcherPid: null })).toBe(false)
        expect(ownsResponsibility({ ...facts, ppid: 50, launcherPid: 51 })).toBe(false)
        expect(ownsResponsibility({ ...facts, ppid: 60, launcherPid: 50 })).toBe(false)
    })

    it('is false for a process under a supervisor such as pm2', () => {
        // pm2 (20) -> launcher (50) -> binary (100); pm2 is responsible for both.
        expect(ownsResponsibility({ pid: 100, ppid: 50, launcherPid: 50, responsibleFor: table({ 100: 20, 50: 20 }) })).toBe(false)
    })
})

describe('captureLauncherPid', () => {
    afterEach(() => captureLauncherPid({}))

    it('removes the launcher pid from the environment so children never inherit it', () => {
        const env: NodeJS.ProcessEnv = { [LAUNCHER_PID_ENV]: '50', KEEP: 'x' }

        captureLauncherPid(env)

        expect(env).toEqual({ KEEP: 'x' })
    })

    it.each([
        ['50', 50],
        ['1', null],
        ['stale', null],
        [undefined, null],
    ])('reads %s as launcher pid %s', (value, expected) => {
        captureLauncherPid(value === undefined ? {} : { [LAUNCHER_PID_ENV]: value })

        expect(getLauncherPid()).toBe(expected)
    })
})

describe('canDisclaimForChildren', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

    afterEach(() => {
        Object.defineProperty(process, 'platform', platform)
        vi.resetModules()
        vi.doUnmock('@/ui/logger')
    })

    it('fails open and logs once when the lookup is unavailable on darwin', async () => {
        const debug = vi.fn()
        vi.doMock('@/ui/logger', () => ({ logger: { debug } }))
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        vi.resetModules()
        const { canDisclaimForChildren } = await import('./responsibility')

        // Vitest runs under Node, where bun:ffi is not available.
        expect(canDisclaimForChildren()).toBe(false)
        expect(canDisclaimForChildren()).toBe(false)
        expect(debug).toHaveBeenCalledTimes(1)
        expect(debug.mock.calls[0][0]).toMatch(/^\[WARN\] \[DISCLAIM\] macOS responsibility lookup unavailable/)
    })

    it('stays silent off darwin', async () => {
        const debug = vi.fn()
        vi.doMock('@/ui/logger', () => ({ logger: { debug } }))
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        vi.resetModules()
        const { canDisclaimForChildren } = await import('./responsibility')

        expect(canDisclaimForChildren()).toBe(false)
        expect(debug).not.toHaveBeenCalled()
    })
})
