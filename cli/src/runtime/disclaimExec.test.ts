import { describe, expect, it, vi } from 'vitest'
import {
    DISCLAIM_FALLBACK_ENV,
    DISCLAIM_RESPONSIBILITY_ENV,
    handleDisclaimExecEntry,
    isRequestForThisProcess,
    reexecArgv,
    runDisclaimExec,
    shouldDisclaimResponsibility,
    takeDisclaimFallbackNote,
    type SpawnExecNative
} from './disclaimExec'

const EXE = '/Users/me/.local/bin/hapi-local'

type FakeNative = SpawnExecNative & { exec: ReturnType<typeof vi.fn>; setenv: ReturnType<typeof vi.fn> }

function fakeNative(options: { canDisclaim?: boolean; unsetOk?: boolean; execResults?: Array<number | 'replaced'> } = {}): FakeNative {
    const results = [...(options.execResults ?? [])]
    return {
        canDisclaim: options.canDisclaim ?? true,
        unsetenv: vi.fn((_name: string) => options.unsetOk ?? true),
        setenv: vi.fn((_name: string, _value: string) => {}),
        // A real exec never returns on success; 'replaced' stands for that by throwing.
        exec: vi.fn((_path: string, _argv: readonly string[], _disclaim: boolean) => {
            const next = results.shift() ?? 1
            if (next === 'replaced') {
                throw new Error('replaced')
            }
            return next
        })
    }
}

describe('shouldDisclaimResponsibility', () => {
    const own = () => true
    const notOwn = () => false

    it('applies only to detached darwin spawns from a process that may hand its responsibility on', () => {
        expect(shouldDisclaimResponsibility('darwin', true, own)).toBe(true)
        expect(shouldDisclaimResponsibility('darwin', true, notOwn)).toBe(false)
        expect(shouldDisclaimResponsibility('darwin', false, own)).toBe(false)
        expect(shouldDisclaimResponsibility('darwin', undefined, own)).toBe(false)
        expect(shouldDisclaimResponsibility('linux', true, own)).toBe(false)
        expect(shouldDisclaimResponsibility('win32', true, own)).toBe(false)
    })

    it('does not consult the responsibility lookup off darwin or for attached spawns', () => {
        const lookup = vi.fn(() => true)
        shouldDisclaimResponsibility('linux', true, lookup)
        shouldDisclaimResponsibility('darwin', false, lookup)
        expect(lookup).not.toHaveBeenCalled()
    })
})

describe('reexecArgv', () => {
    it('drops the virtual bunfs entry of a compiled binary', () => {
        expect(reexecArgv(['bun', '/$bunfs/root/hapi', 'runner', 'start-sync'], EXE)).toEqual([EXE, 'runner', 'start-sync'])
    })

    it('keeps the real entry script in dev mode', () => {
        expect(reexecArgv(['/opt/bun', '/repo/cli/src/index.ts', 'claude', 'a b'], '/opt/bun'))
            .toEqual(['/opt/bun', '/repo/cli/src/index.ts', 'claude', 'a b'])
    })
})

describe('runDisclaimExec', () => {
    const argv = [EXE, 'claude']

    it('clears the request and execs with the disclaim, without logging', () => {
        const native = fakeNative({ execResults: ['replaced'] })
        const log = vi.fn()

        expect(() => runDisclaimExec(EXE, argv, () => native, log)).toThrow('replaced')
        expect(native.unsetenv).toHaveBeenCalledWith(DISCLAIM_RESPONSIBILITY_ENV)
        expect(native.exec).toHaveBeenCalledWith(EXE, argv, true)
        expect(log).not.toHaveBeenCalled()
    })

    it('fails open to a plain exec when the disclaim symbol is missing, with one log line and a note', () => {
        const native = fakeNative({ canDisclaim: false, execResults: ['replaced'] })
        const log = vi.fn()

        expect(() => runDisclaimExec(EXE, argv, () => native, log)).toThrow('replaced')
        expect(native.exec.mock.calls).toEqual([[EXE, argv, false]])
        expect(log).toHaveBeenCalledTimes(1)
        expect(log.mock.calls[0][0]).toContain('disclaim symbol not found')
        expect(native.setenv).toHaveBeenCalledWith(DISCLAIM_FALLBACK_ENV, 'disclaim symbol not found')
    })

    it('fails open to a plain exec when the disclaimed exec returns an error', () => {
        const native = fakeNative({ execResults: [22, 'replaced'] })
        const log = vi.fn()

        expect(() => runDisclaimExec(EXE, argv, () => native, log)).toThrow('replaced')
        expect(native.exec.mock.calls.map((call) => call[2])).toEqual([true, false])
        expect(log).toHaveBeenCalledTimes(1)
        expect(log.mock.calls[0][0]).toContain('code 22')
    })

    it('does not exec when the request cannot be cleared, so the new image cannot loop', () => {
        const native = fakeNative({ unsetOk: false })
        const log = vi.fn()

        runDisclaimExec(EXE, argv, () => native, log)

        expect(native.exec).not.toHaveBeenCalled()
        expect(log).toHaveBeenCalledTimes(1)
    })

    it('returns when the native binding cannot load', () => {
        const log = vi.fn()

        runDisclaimExec(EXE, argv, () => {
            throw new Error('dlopen failed')
        }, log)

        expect(log).toHaveBeenCalledTimes(1)
        expect(log.mock.calls[0][0]).toContain('dlopen failed')
    })

    it('returns when every exec fails', () => {
        const native = fakeNative({ execResults: [1, 2] })
        const log = vi.fn()

        runDisclaimExec(EXE, argv, () => native, log)

        expect(native.exec).toHaveBeenCalledTimes(2)
        expect(log).toHaveBeenCalledTimes(2)
        expect(log.mock.calls[1][0]).toContain('continuing in-process')
    })
})

describe('isRequestForThisProcess', () => {
    it('accepts only the pid of the direct parent', () => {
        expect(isRequestForThisProcess('4242', 4242)).toBe(true)
        expect(isRequestForThisProcess('4242', 4243)).toBe(false)
        expect(isRequestForThisProcess('1', 1)).toBe(false)
        expect(isRequestForThisProcess('', 4242)).toBe(false)
        expect(isRequestForThisProcess('4242x', 4242)).toBe(false)
    })
})

describe('handleDisclaimExecEntry', () => {
    const argv = ['bun', '/$bunfs/root/hapi', 'runner', 'start-sync']
    const PARENT = 4242

    it('does nothing without a request', async () => {
        const loadNative = vi.fn()
        const env: NodeJS.ProcessEnv = { KEEP: 'x' }

        await handleDisclaimExecEntry({ env, argv, platform: 'darwin', ppid: PARENT, loadNative })

        expect(loadNative).not.toHaveBeenCalled()
        expect(env).toEqual({ KEEP: 'x' })
    })

    it('drops a request off darwin without exec', async () => {
        const loadNative = vi.fn()
        const env: NodeJS.ProcessEnv = { [DISCLAIM_RESPONSIBILITY_ENV]: String(PARENT) }

        await handleDisclaimExecEntry({ env, argv, platform: 'linux', ppid: PARENT, loadNative })

        expect(loadNative).not.toHaveBeenCalled()
        expect(env).toEqual({})
    })

    it.each(['1', '9999'])('drops a request addressed to another process (%s), e.g. one leaked through an older binary', async (value) => {
        const loadNative = vi.fn()
        const env: NodeJS.ProcessEnv = { [DISCLAIM_RESPONSIBILITY_ENV]: value }

        await handleDisclaimExecEntry({ env, argv, platform: 'darwin', ppid: PARENT, loadNative })

        expect(loadNative).not.toHaveBeenCalled()
        expect(env).toEqual({})
    })

    it('re-executes its own executable with its own arguments', async () => {
        // A real exec does not return; the fake fails both attempts so the call can be inspected.
        const native = fakeNative({ execResults: [5, 6] })
        const env: NodeJS.ProcessEnv = { [DISCLAIM_RESPONSIBILITY_ENV]: String(PARENT) }

        await handleDisclaimExecEntry({
            env, argv, argv0: '/usr/local/bin/hapi', execPath: EXE, platform: 'darwin', ppid: PARENT,
            loadNative: async () => () => native, writeStderr: vi.fn()
        })

        expect(native.exec.mock.calls[0]).toEqual([EXE, ['/usr/local/bin/hapi', 'runner', 'start-sync'], true])
        expect(env[DISCLAIM_RESPONSIBILITY_ENV]).toBeUndefined()
    })

    it('continues in-process with the request cleared and a fallback note for the log', async () => {
        const env: NodeJS.ProcessEnv = { [DISCLAIM_RESPONSIBILITY_ENV]: String(PARENT) }
        const writeStderr = vi.fn()

        await handleDisclaimExecEntry({
            env, argv, execPath: EXE, platform: 'darwin', ppid: PARENT, writeStderr,
            loadNative: async () => {
                throw new Error('no bun:ffi')
            }
        })

        expect(env[DISCLAIM_RESPONSIBILITY_ENV]).toBeUndefined()
        expect(writeStderr).toHaveBeenCalledTimes(1)
        const note = takeDisclaimFallbackNote(env)
        expect(note).toContain('no bun:ffi')
        expect(env[DISCLAIM_FALLBACK_ENV]).toBeUndefined()
    })

    it('continues in-process when the native binding throws mid-way', async () => {
        const native = fakeNative()
        native.unsetenv = vi.fn(() => {
            throw new TypeError('ffi call failed')
        })
        const env: NodeJS.ProcessEnv = { [DISCLAIM_RESPONSIBILITY_ENV]: String(PARENT) }
        const writeStderr = vi.fn()

        await expect(handleDisclaimExecEntry({
            env, argv, execPath: EXE, platform: 'darwin', ppid: PARENT, writeStderr,
            loadNative: async () => () => native
        })).resolves.toBeUndefined()

        expect(native.exec).not.toHaveBeenCalled()
        expect(writeStderr).toHaveBeenCalledTimes(1)
        expect(takeDisclaimFallbackNote(env)).toContain('ffi call failed')
    })
})
