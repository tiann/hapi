import type { SpawnOptions } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json'

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn((..._args: unknown[]) => ({ pid: 12345 }) as unknown),
}))

let root = ''
let bunCompiled = false
let cliExecutable = ''

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>()
    return { ...actual, spawn: spawnMock }
})
vi.mock('@/projectPath', () => ({
    projectPath: () => join(root, 'cli'),
    isBunCompiled: () => bunCompiled,
    runtimePath: () => join(root, 'runtime'),
}))
vi.mock('@/utils/spawnHappyCLI', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/spawnHappyCLI')>()
    return { ...actual, resolveHappyCliExecutable: () => cliExecutable }
})

import { spawnSessionWrapper } from '@/utils/spawnHappyCLI'
import {
    resolveRustExecutable,
    resolveWrapperRuntime,
    SUPPORTED_RUST_WRAPPER_FLAVORS,
} from './wrapperRuntime'

const originalCliExecutable = process.env.HAPI_CLI_EXECUTABLE
const originalDisclaim = process.env.HAPI_DISCLAIM_RESPONSIBILITY

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wrapper-runtime-'))
    bunCompiled = false
    cliExecutable = join(root, 'link')
    spawnMock.mockClear()
    delete process.env.HAPI_CLI_EXECUTABLE
    delete process.env.HAPI_DISCLAIM_RESPONSIBILITY
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (originalCliExecutable === undefined) delete process.env.HAPI_CLI_EXECUTABLE
    else process.env.HAPI_CLI_EXECUTABLE = originalCliExecutable
    if (originalDisclaim === undefined) delete process.env.HAPI_DISCLAIM_RESPONSIBILITY
    else process.env.HAPI_DISCLAIM_RESPONSIBILITY = originalDisclaim
})

describe('resolveWrapperRuntime', () => {
    it('exports an empty supported flavor list until a Rust wrapper lands in this tree', () => {
        expect(SUPPORTED_RUST_WRAPPER_FLAVORS).toEqual([])
        const bin = join(root, 'hapi-session-wrapper')
        symlinkSync(process.execPath, bin)
        const env = { HAPI_RUST_WRAPPER_BIN: bin, HAPI_RUST_WRAPPER_FLAVORS: 'claude,codex,agy' }
        for (const flavor of ['claude', 'codex', 'agy']) {
            expect(resolveWrapperRuntime(flavor, env, 'linux', 'remote')).toEqual({
                runtime: 'ts',
                reason: 'unsupported flavor',
            })
        }
    })

    it('defaults to ts for every flavor, platform, and mode when env is unset or empty', () => {
        const bin = join(root, 'hapi-session-wrapper')
        symlinkSync(process.execPath, bin)
        const envs: NodeJS.ProcessEnv[] = [
            {},
            { HAPI_RUST_WRAPPER_BIN: bin },
            { HAPI_RUST_WRAPPER_BIN: bin, HAPI_RUST_WRAPPER_FLAVORS: '' },
            { HAPI_RUST_WRAPPER_BIN: bin, HAPI_RUST_WRAPPER_FLAVORS: ' , , ' },
        ]
        const flavors = ['claude', 'codex', 'agy', 'pi', 'gemini', 'opencode', 'cursor', '']
        const platforms: NodeJS.Platform[] = ['linux', 'darwin', 'win32']
        const modes = [undefined, 'remote', 'local', 'pty']
        for (const env of envs) {
            for (const flavor of flavors) {
                for (const platform of platforms) {
                    for (const mode of modes) {
                        expect(resolveWrapperRuntime(flavor, env, platform, mode, ['claude', 'codex'])).toEqual({
                            runtime: 'ts',
                            reason: 'flavor disabled',
                        })
                    }
                }
            }
        }
    })

    it('disables everything when HAPI_RUST_WRAPPER_FLAVORS contains none', () => {
        const bin = join(root, 'hapi-session-wrapper')
        symlinkSync(process.execPath, bin)
        for (const list of ['none', ' NONE ', 'claude,none', 'none,codex']) {
            expect(resolveWrapperRuntime(
                'claude',
                { HAPI_RUST_WRAPPER_BIN: bin, HAPI_RUST_WRAPPER_FLAVORS: list },
                'linux',
                'remote',
                ['claude', 'codex'],
            )).toEqual({ runtime: 'ts', reason: 'flavor disabled' })
        }
    })

    it('enforces platform, startingMode, supported flavors, and case-insensitive flavor matching', () => {
        const bin = join(root, 'hapi-session-wrapper')
        symlinkSync(process.execPath, bin)
        const env = { HAPI_RUST_WRAPPER_BIN: bin, HAPI_RUST_WRAPPER_FLAVORS: ' Claude , CODEX , pi ' }
        const supported = ['claude', 'codex']

        expect(resolveWrapperRuntime('claude', env, 'linux', undefined, supported)).toEqual({ runtime: 'rust', bin })
        expect(resolveWrapperRuntime('CODEX', env, 'linux', 'remote', supported)).toEqual({ runtime: 'rust', bin })
        expect(resolveWrapperRuntime('claude', env, 'linux', 'pty', supported)).toEqual({ runtime: 'rust', bin })
        expect(resolveWrapperRuntime('pi', env, 'linux', 'remote', supported)).toEqual({
            runtime: 'ts',
            reason: 'unsupported flavor',
        })
        expect(resolveWrapperRuntime('codex', env, 'darwin', 'remote', supported)).toEqual({
            runtime: 'ts',
            reason: 'unsupported platform',
        })
        expect(resolveWrapperRuntime('codex', env, 'win32', 'remote', supported)).toEqual({
            runtime: 'ts',
            reason: 'unsupported platform',
        })
        expect(resolveWrapperRuntime('codex', env, 'linux', 'local', supported)).toEqual({
            runtime: 'ts',
            reason: 'local mode',
        })
        expect(resolveWrapperRuntime('agy', env, 'linux', 'remote', supported)).toEqual({
            runtime: 'ts',
            reason: 'flavor disabled',
        })
    })
})

describe('resolveRustExecutable', () => {
    it('resolves override, real CLI sibling, then dev target/release in order and falls through on invalid override', () => {
        const bin = 'hapi-session-wrapper'
        const release = join(root, 'target', 'release', bin)
        const sibling = join(root, 'bin', bin)
        const nonExecOverride = join(root, 'nonexec', bin)
        const dirOverride = join(root, 'dir-override', bin)
        mkdirSync(join(root, 'target', 'release'), { recursive: true })
        mkdirSync(join(root, 'bin'))
        mkdirSync(join(root, 'nonexec'))
        mkdirSync(dirOverride, { recursive: true })
        writeFileSync(join(root, 'bin', 'hapi'), '')
        symlinkSync(join(root, 'bin', 'hapi'), join(root, 'link'))
        writeFileSync(nonExecOverride, '', { mode: 0o644 })

        const env: NodeJS.ProcessEnv = { HAPI_RUST_WRAPPER_FLAVORS: 'claude', HAPI_RUST_WRAPPER_BIN: root }
        const select = () => resolveWrapperRuntime('claude', env, 'linux', 'remote', ['claude'])

        expect(resolveRustExecutable(env)).toBeNull()
        expect(select()).toEqual({ runtime: 'ts', reason: 'binary unavailable' })

        writeFileSync(release, '', { mode: 0o755 })
        writeFileSync(sibling, '', { mode: 0o644 })
        expect(select()).toEqual({ runtime: 'rust', bin: release })

        // Compiled builds must not fall back to a dev target/release directory.
        bunCompiled = true
        expect(resolveRustExecutable(env)).toBeNull()
        expect(select()).toEqual({ runtime: 'ts', reason: 'binary unavailable' })
        bunCompiled = false

        chmodSync(sibling, 0o755)
        expect(select()).toEqual({ runtime: 'rust', bin: sibling })

        // Invalid HAPI_RUST_WRAPPER_BIN values all fall through to the sibling.
        for (const invalid of [
            process.execPath,
            bin,
            `./${bin}`,
            dirOverride,
            nonExecOverride,
            join(root, 'missing', bin),
        ]) {
            env.HAPI_RUST_WRAPPER_BIN = invalid
            expect(resolveRustExecutable(env)).toBe(sibling)
            expect(select()).toEqual({ runtime: 'rust', bin: sibling })
        }

        const validOverride = join(root, bin)
        symlinkSync(process.execPath, validOverride)
        env.HAPI_RUST_WRAPPER_BIN = validOverride
        expect(resolveRustExecutable(env)).toBe(validOverride)
        expect(select()).toEqual({ runtime: 'rust', bin: validOverride })
    })
})

describe('spawnSessionWrapper', () => {
    it('delegates ts runtimes to spawnHappyCLI', () => {
        mkdirSync(join(root, 'cli', 'src'), { recursive: true })
        writeFileSync(join(root, 'cli', 'src', 'index.ts'), '')

        spawnSessionWrapper({ runtime: 'ts', reason: 'flavor disabled' }, ['claude', '--started-by', 'runner'], {
            cwd: '/workspace/project',
            stdio: 'ignore',
        })

        expect(spawnMock).toHaveBeenCalledTimes(1)
        const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions]
        expect(command).not.toBe('/wrapper')
        expect(args).toContain(join(root, 'cli', 'src', 'index.ts'))
        expect(args.slice(-3)).toEqual(['claude', '--started-by', 'runner'])
        expect(options.env?.HAPI_INVOKED_CWD).toBe('/workspace/project')
    })

    it('spawns Rust directly with verbatim CLI arguments and wrapper metadata in compiled mode', () => {
        bunCompiled = true
        const hapiBin = join(root, 'hapi')
        writeFileSync(hapiBin, '', { mode: 0o755 })
        process.env.HAPI_CLI_EXECUTABLE = hapiBin
        process.env.HAPI_DISCLAIM_RESPONSIBILITY = '999'

        const args = ['claude', '--model', 'model with spaces', '--started-by', 'runner']
        spawnSessionWrapper({ runtime: 'rust', bin: '/wrapper' }, args, {
            detached: true,
            env: { EXTRA: 'keep' },
        })

        expect(spawnMock).toHaveBeenCalledWith('/wrapper', args, {
            detached: true,
            env: expect.objectContaining({
                EXTRA: 'keep',
                HAPI_CLI_EXECUTABLE: hapiBin,
                HAPI_WRAPPER_CLI_VERSION: packageJson.version,
                HAPI_WRAPPER_RUNTIME_PATH: join(root, 'runtime'),
            }),
        })
        const options = spawnMock.mock.calls[0]![2] as SpawnOptions
        expect('HAPI_DISCLAIM_RESPONSIBILITY' in (options.env ?? {})).toBe(false)
    })

    it.each([true, false])('uses explicit session cwd for Rust and only overwrites HAPI_CLI_EXECUTABLE when compiled=%s', (compiled) => {
        bunCompiled = compiled
        const hapiBin = join(root, 'hapi')
        writeFileSync(hapiBin, '', { mode: 0o755 })
        if (compiled) process.env.HAPI_CLI_EXECUTABLE = hapiBin

        for (const executable of [undefined, '/configured/hapi']) {
            const env = { HAPI_INVOKED_CWD: '/runner', HAPI_CLI_EXECUTABLE: executable }
            spawnSessionWrapper({ runtime: 'rust', bin: '/wrapper' }, [], {
                cwd: new URL('file:///project/worktree'),
                env,
            })
            const options = spawnMock.mock.lastCall![2] as SpawnOptions
            expect(options.env?.HAPI_INVOKED_CWD).toBe('/project/worktree')
            if (compiled) expect(options.env?.HAPI_CLI_EXECUTABLE).toBe(hapiBin)
            else expect(options.env?.HAPI_CLI_EXECUTABLE).toBe(executable)
        }

        // Without cwd, an inherited absolute HAPI_INVOKED_CWD is preserved.
        spawnSessionWrapper({ runtime: 'rust', bin: '/wrapper' }, [], {
            env: { HAPI_INVOKED_CWD: '/inherited/workspace' },
        })
        const inheritedOptions = spawnMock.mock.lastCall![2] as SpawnOptions
        expect(inheritedOptions.env?.HAPI_INVOKED_CWD).toBe('/inherited/workspace')
    })
})
