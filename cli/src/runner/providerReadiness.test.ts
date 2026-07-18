import { beforeEach, describe, expect, it, vi } from 'vitest'
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Stats } from 'node:fs'
import {
    AGENT_FLAVORS,
    PROVIDER_READINESS_READY_REFRESH_MS,
    PROVIDER_READINESS_RETRY_REFRESH_MS,
    getProviderAvailability,
    type AgentFlavor,
} from '@hapi/protocol'
import { ProviderReadinessSchema } from '@hapi/protocol/schemas'
import { getProviderCommand, type ProviderCommandResult, type ProviderCommandSpec } from './providerRuntime'
import {
    PROVIDER_CREDENTIAL_FILE_MAX_BYTES,
    ProviderReadinessService,
    SingleFlightCredentialReadPool,
    assertSameWindowsCredentialAncestorIdentities,
    captureWindowsCredentialAncestorIdentities,
    isMissingProviderCommandResult,
    isUnsafeWindowsCredentialPath,
} from './providerReadiness'

const START = 1_800_000_000_000

function commandResult(overrides: Partial<ProviderCommandResult> = {}): ProviderCommandResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        ...overrides,
    }
}

function credentialPathStats(options: {
    dev?: number
    ino?: number
    directory?: boolean
    symbolicLink?: boolean
} = {}): Stats {
    return {
        dev: options.dev ?? 1,
        ino: options.ino ?? 1,
        isDirectory: () => options.directory ?? true,
        isSymbolicLink: () => options.symbolicLink ?? false,
    } as Stats
}

function versionOutput(flavor: AgentFlavor): string {
    if (flavor === 'grok') return 'grok 0.2.101 (fixture)\n'
    if (flavor === 'cursor') return '2026.05.05-84a231c\n'
    if (flavor === 'codex') return 'codex-cli 0.144.3\n'
    return '1.2.3\n'
}

function authStatusResult(spec: ProviderCommandSpec): ProviderCommandResult {
    if (spec.args.join(' ') === 'auth status --json') {
        return commandResult({ stdout: JSON.stringify({ loggedIn: true, accountEmail: 'user@example.com' }) })
    }
    if (spec.args.join(' ') === 'login status') {
        return commandResult({ stdout: 'Logged in using ChatGPT\n' })
    }
    if (spec.args.join(' ') === 'status --format json') {
        return commandResult({ stdout: JSON.stringify({ authenticated: true, account: 'must-not-leak' }) })
    }
    return commandResult({ stdout: 'unexpected status command' })
}

describe('provider runtime resolution', () => {
    it('uses the canonical provider commands and never aliases Cursor to generic agent', () => {
        const env = { HOME: '/Users/example' }
        expect(getProviderCommand('claude', env)).toBe('claude')
        expect(getProviderCommand('claude-deepseek', env)).toBe('/Users/example/.local/bin/claude-deepseek')
        expect(getProviderCommand('claude-ark', env)).toBe('/Users/example/.local/bin/claude-ark')
        expect(getProviderCommand('cc-api', env)).toBe('/Users/example/.local/bin/claude-api')
        expect(getProviderCommand('codex', env)).toBe('codex')
        expect(getProviderCommand('agy', env)).toBe('agy')
        expect(getProviderCommand('grok', env)).toBe('grok')
        expect(getProviderCommand('opencode', env)).toBe('opencode')
        expect(getProviderCommand('cursor', env)).toBe('cursor-agent')
        expect(getProviderCommand('hermes-moa', env)).toBe('/Users/example/.local/bin/hermes')
    })

    it('honors only the provider-specific command overrides', () => {
        expect(getProviderCommand('claude', { HAPI_CLAUDE_PATH: '/opt/claude' })).toBe('/opt/claude')
        expect(getProviderCommand('cursor', { HAPI_CURSOR_PATH: '/opt/cursor-agent' })).toBe('/opt/cursor-agent')
        expect(getProviderCommand('grok', { HAPI_CURSOR_PATH: '/not/grok' })).toBe('grok')
    })
})

describe('ProviderReadinessService', () => {
    let now: number

    beforeEach(() => {
        now = START
    })

    function createService(options: {
        runCommand: (spec: ProviderCommandSpec) => Promise<ProviderCommandResult>
        readFile?: (path: string) => Promise<string>
    }) {
        return new ProviderReadinessService({
            env: { HOME: '/Users/example', HAPI_HOME: '/tmp/hapi-home' },
            now: () => now,
            runCommand: options.runCommand,
            readFile: options.readFile ?? (async () => JSON.stringify({
                'https://accounts.x.ai/sign-in': { key: 'fixture-secret' },
            })),
        })
    }

    it('reports a missing executable without running any follow-up command', async () => {
        const runCommand = vi.fn(async () => commandResult({ exitCode: null, errorCode: 'ENOENT' }))
        const service = createService({ runCommand })

        const result = await service.probe('grok')

        expect(result).toMatchObject({
            status: 'not-installed',
            installed: false,
            authenticated: null,
            version: null,
        })
        expect(runCommand).toHaveBeenCalledOnce()
        expect(ProviderReadinessSchema.parse(result)).toEqual(result)
    })

    it('classifies Windows shell command-not-found output as not installed', async () => {
        const missing = commandResult({
            exitCode: 1,
            stderr: "'missing-provider' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
        })
        expect(isMissingProviderCommandResult(missing, 'win32')).toBe(true)

        const runCommand = vi.fn(async () => missing)
        const service = new ProviderReadinessService({
            env: { HOME: 'C:\\Users\\example' },
            now: () => now,
            platform: 'win32',
            runCommand,
        })
        await expect(service.probe('cursor')).resolves.toMatchObject({
            status: 'not-installed',
            installed: false,
        })
        expect(runCommand).toHaveBeenCalledOnce()
    })

    it('reports bounded command timeouts as probe failures', async () => {
        const runCommand = vi.fn(async () => commandResult({
            exitCode: null,
            timedOut: true,
        }))
        const service = createService({ runCommand })

        await expect(service.probe('grok')).resolves.toMatchObject({
            status: 'probe-failed',
            installed: true,
            authenticated: null,
            version: null,
        })
        expect(runCommand).toHaveBeenCalledOnce()
    })

    it('performs Grok preflight with version plus schema-only credential reading', async () => {
        const secretFixture = 'grok-secret-that-must-not-leak'
        const runCommand = vi.fn(async (_spec: ProviderCommandSpec) => commandResult({ stdout: 'grok 0.2.101 (fixture)\n' }))
        const readFile = vi.fn(async () => JSON.stringify({
            'https://accounts.x.ai/sign-in': {
                key: secretFixture,
                expires_at: 1_900_000_000,
            },
        }))
        const service = createService({ runCommand, readFile })

        const result = await service.probe('grok')

        expect(result).toMatchObject({
            status: 'ready',
            installed: true,
            authenticated: true,
            authCheck: 'credential-file',
            version: '0.2.101',
            minimumVersion: '0.2.93',
            experimental: true,
        })
        expect(runCommand).toHaveBeenCalledTimes(1)
        expect(runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([['version']])
        expect(runCommand.mock.calls.flatMap(([spec]) => spec.args)).not.toContain('login')
        expect(runCommand.mock.calls.flatMap(([spec]) => spec.args)).not.toContain('agent')
        expect(readFile).toHaveBeenCalledWith('/Users/example/.grok/auth.json')
        expect(JSON.stringify(result)).not.toContain(secretFixture)
    })

    it('accepts a non-empty Grok refresh token without publishing its value', async () => {
        const secretFixture = 'refresh-secret-that-must-not-leak'
        const service = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile: async () => JSON.stringify({
                'https://accounts.x.ai/sign-in::client': { refresh_token: `  ${secretFixture}  ` },
            }),
        })

        const result = await service.probe('grok')

        expect(result).toMatchObject({ status: 'ready', authenticated: true })
        expect(JSON.stringify(result)).not.toContain(secretFixture)
    })

    it('fails closed for missing and malformed Grok credential files', async () => {
        const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
        const missingService = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile: async () => { throw missing },
        })
        const malformedService = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile: async () => '{not-json',
        })

        const missingResult = await missingService.probe('grok')
        const malformedResult = await malformedService.probe('grok')

        expect(missingResult).toMatchObject({
            status: 'not-authenticated',
            authenticated: false,
        })
        expect(getProviderAvailability({ grok: missingResult }, 'grok', now)).toMatchObject({
            ok: false,
            code: 'provider-not-authenticated',
            recoveryCommand: 'grok login --device-code',
        })
        expect(malformedResult).toMatchObject({
            status: 'probe-failed',
            authenticated: null,
        })
    })

    it('rejects unrelated or deeply nested key-shaped Grok settings', async () => {
        const service = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile: async () => JSON.stringify({
                preferences: { key: 'dark' },
                profile: { oauth: { refresh_token: 'not-a-scoped-record' } },
            }),
        })

        await expect(service.probe('grok')).resolves.toMatchObject({
            status: 'not-authenticated',
            authenticated: false,
        })
    })

    it('rejects Windows device-namespace credential paths without invoking the reader', async () => {
        const readFile = vi.fn(async () => JSON.stringify({
            'https://accounts.x.ai/sign-in': { key: 'must-not-authorize' },
        }))
        const service = new ProviderReadinessService({
            env: { HOME: 'C:\\Users\\example', GROK_HOME: '\\\\.\\pipe\\grok' },
            now: () => now,
            platform: 'win32',
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile,
        })

        await expect(service.probe('grok')).resolves.toMatchObject({
            status: 'probe-failed',
            authenticated: null,
        })
        expect(readFile).not.toHaveBeenCalled()
    })

    it('rejects Windows credential paths with namespaces, aliases, or ambiguous components', () => {
        expect(isUnsafeWindowsCredentialPath('C:\\Users\\example\\.grok\\auth.json')).toBe(false)
        for (const path of [
            '\\\\.\\pipe\\grok\\auth.json',
            '\\\\?\\C:\\Users\\example\\.grok\\auth.json',
            '\\\\server\\share\\.grok\\auth.json',
            'C:.grok\\auth.json',
            'C:\\temp\\NUL \\auth.json',
            'C:\\temp\\COM1.txt\\auth.json',
            'C:\\temp\\folder:stream\\auth.json',
        ]) {
            expect(isUnsafeWindowsCredentialPath(path), path).toBe(true)
        }
    })

    it('rejects Windows credential paths with junction ancestors', async () => {
        const lstatPath = vi.fn(async (path: string) => credentialPathStats({
            symbolicLink: path === 'C:\\Users\\example\\.grok',
        }))

        await expect(captureWindowsCredentialAncestorIdentities(
            'C:\\Users\\example\\.grok\\auth.json',
            lstatPath,
        )).rejects.toThrow(/ancestor is a symbolic link/)
        expect(lstatPath.mock.calls.map(([path]) => path)).toEqual([
            'C:\\',
            'C:\\Users',
            'C:\\Users\\example',
            'C:\\Users\\example\\.grok',
        ])
    })

    it('detects Windows credential ancestor identity changes', async () => {
        let ino = 10
        const baseline = await captureWindowsCredentialAncestorIdentities(
            'C:\\Users\\example\\.grok\\auth.json',
            async () => credentialPathStats({ ino: ino++ }),
        )
        const changed = baseline.map((identity, index) => (
            index === 1 ? { ...identity, ino: identity.ino + 100 } : identity
        ))

        expect(() => assertSameWindowsCredentialAncestorIdentities(baseline, changed))
            .toThrow(/ancestor identity changed/)
        expect(() => assertSameWindowsCredentialAncestorIdentities(baseline, baseline))
            .not.toThrow()
    })

    it('single-flights credential reads and caps unresolved distinct operations', async () => {
        const pool = new SingleFlightCredentialReadPool(1)
        let resolveRead!: (contents: string) => void
        const pendingRead = new Promise<string>((resolve) => {
            resolveRead = resolve
        })
        const startRead = vi.fn(() => pendingRead)

        const first = pool.run('credential-a', startRead)
        const second = pool.run('credential-a', startRead)
        await Promise.resolve()

        expect(startRead).toHaveBeenCalledOnce()
        const blockedRead = vi.fn(async () => 'must-not-run')
        await expect(pool.run('credential-b', blockedRead)).rejects.toMatchObject({ code: 'EBUSY' })
        expect(blockedRead).not.toHaveBeenCalled()

        resolveRead('contents')
        await expect(Promise.all([first, second])).resolves.toEqual(['contents', 'contents'])

        const restartedRead = vi.fn(async () => 'new-contents')
        await expect(pool.run('credential-a', restartedRead)).resolves.toBe('new-contents')
        expect(restartedRead).toHaveBeenCalledOnce()
    })

    it.skipIf(process.platform === 'win32')('rejects a non-regular Grok credential path without reading it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-grok-readiness-special-file-'))
        try {
            const grokHome = join(root, 'grok')
            await mkdir(grokHome, { recursive: true })
            await symlink('/dev/null', join(grokHome, 'auth.json'))
            const service = new ProviderReadinessService({
                env: { HOME: root, GROK_HOME: grokHome },
                now: () => now,
                runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            })

            await expect(service.probe('grok')).resolves.toMatchObject({
                status: 'probe-failed',
                authenticated: null,
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it.skipIf(process.platform === 'win32')('rejects a Grok credential FIFO without blocking', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-grok-readiness-fifo-'))
        try {
            const grokHome = join(root, 'grok')
            const credentialPath = join(grokHome, 'auth.json')
            await mkdir(grokHome, { recursive: true })
            execFileSync('mkfifo', [credentialPath])
            const service = new ProviderReadinessService({
                env: { HOME: root, GROK_HOME: grokHome },
                now: () => now,
                runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            })

            await expect(service.probe('grok')).resolves.toMatchObject({
                status: 'probe-failed',
                authenticated: null,
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('rejects an oversized Grok credential file using a fixed read bound', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-grok-readiness-oversized-'))
        try {
            const grokHome = join(root, 'grok')
            await mkdir(grokHome, { recursive: true })
            await writeFile(
                join(grokHome, 'auth.json'),
                Buffer.alloc(PROVIDER_CREDENTIAL_FILE_MAX_BYTES + 1, 'x')
            )
            const service = new ProviderReadinessService({
                env: { HOME: root, GROK_HOME: grokHome },
                now: () => now,
                runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            })

            await expect(service.probe('grok')).resolves.toMatchObject({
                status: 'probe-failed',
                authenticated: null,
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it.skipIf(process.platform === 'win32')('rejects a multiply linked Grok credential file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-grok-readiness-hardlink-'))
        try {
            const grokHome = join(root, 'grok')
            const outside = join(root, 'credential-source.json')
            await mkdir(grokHome, { recursive: true })
            await writeFile(outside, JSON.stringify({
                'https://accounts.x.ai/sign-in': { key: 'must-not-authorize' },
            }))
            await link(outside, join(grokHome, 'auth.json'))
            const service = new ProviderReadinessService({
                env: { HOME: root, GROK_HOME: grokHome },
                now: () => now,
                runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            })

            await expect(service.probe('grok')).resolves.toMatchObject({
                status: 'probe-failed',
                authenticated: null,
            })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('rejects Grok versions below the committed ACP minimum before reading credentials', async () => {
        const readFile = vi.fn(async () => JSON.stringify({ oauth: { key: 'secret' } }))
        const service = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.92\n' }),
            readFile,
        })

        await expect(service.probe('grok')).resolves.toMatchObject({
            status: 'unsupported-version',
            version: '0.2.92',
            minimumVersion: '0.2.93',
        })
        expect(readFile).not.toHaveBeenCalled()
    })

    it('uses GROK_HOME only to locate the read-only credential record', async () => {
        const readFile = vi.fn(async () => JSON.stringify({ oauth: { key: 'secret' } }))
        const service = new ProviderReadinessService({
            env: { HOME: '/Users/example', GROK_HOME: '/var/lib/grok' },
            now: () => now,
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile,
        })

        await service.probe('grok')

        expect(readFile).toHaveBeenCalledWith('/var/lib/grok/auth.json')
    })

    it.each([
        {
            flavor: 'claude' as const,
            version: '2.1.207 (Claude Code)\n',
            expectedArgs: [['--version'], ['auth', 'status', '--json']],
        },
        {
            flavor: 'codex' as const,
            version: 'codex-cli 0.144.3\n',
            expectedArgs: [['--version'], ['login', 'status']],
        },
        {
            flavor: 'cursor' as const,
            version: '2026.05.05-84a231c\n',
            expectedArgs: [['--version'], ['status', '--format', 'json']],
        },
    ])('uses the documented read-only auth status contract for $flavor', async ({ flavor, version, expectedArgs }) => {
        const runCommand = vi.fn(async (spec: ProviderCommandSpec) => {
            if (spec.args[0] === '--version') return commandResult({ stdout: version })
            return authStatusResult(spec)
        })
        const service = createService({ runCommand })

        const result = await service.probe(flavor)

        expect(result).toMatchObject({
            status: 'ready',
            installed: true,
            authenticated: true,
            authCheck: 'command',
        })
        expect(runCommand.mock.calls.map(([spec]) => spec.args)).toEqual(expectedArgs)
        expect(JSON.stringify(result)).not.toContain('must-not-leak')
    })

    it('probes Codex without creating or selecting the managed launch home', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-codex-readiness-no-write-'))
        const fakeHome = join(root, 'home')
        const hapiHome = join(root, 'hapi')
        await mkdir(fakeHome, { recursive: true })
        const calls: ProviderCommandSpec[] = []
        const service = new ProviderReadinessService({
            env: { HOME: fakeHome, HAPI_HOME: hapiHome },
            now: () => now,
            runCommand: async (spec) => {
                calls.push(spec)
                return spec.args[0] === '--version'
                    ? commandResult({ stdout: 'codex-cli 0.144.3\n' })
                    : commandResult({ stdout: 'Logged in using ChatGPT\n' })
            },
        })

        await expect(service.probe('codex')).resolves.toMatchObject({ status: 'ready' })
        expect(calls).toHaveLength(2)
        expect(calls.every((spec) => spec.env.CODEX_HOME === join(fakeHome, '.codex'))).toBe(true)
        await expect(lstat(join(hapiHome, 'codex-home'))).rejects.toThrow()
    })

    it('distinguishes an explicit official status failure from an unreadable status response', async () => {
        const loggedOut = createService({
            runCommand: async (spec) => spec.args[0] === '--version'
                ? commandResult({ stdout: 'codex-cli 0.144.3\n' })
                : commandResult({ exitCode: 1, stdout: 'Not logged in\n' }),
        })
        const malformed = createService({
            runCommand: async (spec) => spec.args[0] === '--version'
                ? commandResult({ stdout: '2026.05.05-84a231c\n' })
                : commandResult({ stdout: '{not-json' }),
        })
        const contradictory = createService({
            runCommand: async (spec) => spec.args[0] === '--version'
                ? commandResult({ stdout: '2026.05.05-84a231c\n' })
                : commandResult({ exitCode: 1, stdout: JSON.stringify({ authenticated: true }) }),
        })

        await expect(loggedOut.probe('codex')).resolves.toMatchObject({
            status: 'not-authenticated',
            authenticated: false,
        })
        await expect(malformed.probe('cursor')).resolves.toMatchObject({
            status: 'probe-failed',
            authenticated: null,
        })
        await expect(contradictory.probe('cursor')).resolves.toMatchObject({
            status: 'probe-failed',
            authenticated: null,
        })
    })

    it('does not invent authentication state for providers without a safe status command', async () => {
        const runCommand = vi.fn(async (_spec: ProviderCommandSpec) => commandResult({ stdout: 'agy 1.1.3\n' }))
        const service = createService({ runCommand })

        const result = await service.probe('agy')

        expect(result).toMatchObject({
            status: 'ready',
            authenticated: null,
            authCheck: 'unavailable',
            version: '1.1.3',
        })
        expect(runCommand.mock.calls.map(([spec]) => spec.args)).toEqual([['--version']])
    })

    it('passes only runtime essentials and selected-provider variables to probe children', async () => {
        const calls: ProviderCommandSpec[] = []
        const service = new ProviderReadinessService({
            env: {
                HOME: '/Users/example',
                PATH: '/usr/bin',
                LANG: 'C.UTF-8',
                GROK_HOME: '/var/lib/grok',
                GROK_TOKEN: 'selected-provider-secret',
                OPENAI_API_KEY: 'cross-provider-secret',
                FEISHU_APP_SECRET: 'unrelated-secret',
            },
            now: () => now,
            runCommand: async (spec) => {
                calls.push(spec)
                return commandResult({ stdout: 'grok 0.2.101\n' })
            },
            readFile: async () => JSON.stringify({ oauth: { key: 'credential-file-secret' } }),
        })

        await service.probe('grok')

        expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual([
            'GROK_HOME', 'GROK_TOKEN', 'HOME', 'LANG', 'PATH',
        ])
        expect(calls[0]?.env.HOME).toBe('/Users/example')
        expect(calls[0]?.env.PATH).toBe('/Users/example/.local/bin:/usr/bin')
    })

    it('probes all canonical flavors and refreshes ready entries only when due', async () => {
        const runCommand = vi.fn(async (spec: ProviderCommandSpec) => {
            if (spec.args[0] === '--version' || spec.args[0] === 'version') {
                const flavor = AGENT_FLAVORS.find((candidate) => getProviderCommand(candidate, {
                    HOME: '/Users/example',
                }) === spec.command) ?? 'claude'
                return commandResult({ stdout: versionOutput(flavor) })
            }
            return authStatusResult(spec)
        })
        const service = createService({ runCommand })

        const initial = await service.probeAll()
        expect(Object.keys(initial).sort()).toEqual([...AGENT_FLAVORS].sort())
        expect(service.snapshot()).toEqual(initial)

        runCommand.mockClear()
        now += PROVIDER_READINESS_READY_REFRESH_MS - 1
        await expect(service.refreshDue()).resolves.toEqual({ changed: false, snapshot: initial })
        expect(runCommand).not.toHaveBeenCalled()

        now += 1
        const refreshed = await service.refreshDue()
        expect(refreshed.changed).toBe(true)
        expect(Object.keys(refreshed.snapshot).sort()).toEqual([...AGENT_FLAVORS].sort())
        expect(runCommand).toHaveBeenCalled()

        runCommand.mockClear()
        now = START
        await expect(service.refreshDue()).resolves.toMatchObject({ changed: true })
        expect(runCommand).toHaveBeenCalled()
    })

    it('retries unavailable providers on the shorter refresh interval', async () => {
        const runCommand = vi.fn(async (spec: ProviderCommandSpec) => {
            if (spec.command === 'grok') {
                return commandResult({ exitCode: null, errorCode: 'ENOENT' })
            }
            if (spec.args[0] === '--version') return commandResult({ stdout: '1.2.3\n' })
            return authStatusResult(spec)
        })
        const service = createService({ runCommand })
        await service.probeAll()
        expect(service.snapshot().grok?.status).toBe('not-installed')

        runCommand.mockClear()
        now += PROVIDER_READINESS_RETRY_REFRESH_MS - 1
        await expect(service.refreshDue()).resolves.toMatchObject({ changed: false })
        expect(runCommand).not.toHaveBeenCalled()

        now += 1
        await expect(service.refreshDue()).resolves.toMatchObject({ changed: true })
        expect(runCommand.mock.calls.map(([spec]) => ({ command: spec.command, args: spec.args }))).toEqual([
            { command: 'grok', args: ['version'] },
        ])
    })

    it('single-flights overlapping probes for the same provider flavor', async () => {
        let resolveFirst!: (result: ProviderCommandResult) => void
        const firstVersion = new Promise<ProviderCommandResult>((resolve) => {
            resolveFirst = resolve
        })
        let versionCalls = 0
        const service = createService({
            runCommand: async (spec) => {
                if (spec.command === 'grok' && spec.args[0] === 'version') {
                    versionCalls += 1
                    if (versionCalls === 1) return await firstVersion
                    return commandResult({ stdout: 'grok 0.2.101\n' })
                }
                return authStatusResult(spec)
            },
        })

        const first = service.probe('grok')
        await vi.waitFor(() => expect(versionCalls).toBe(1))
        const second = service.probe('grok')
        await new Promise((resolve) => setImmediate(resolve))
        resolveFirst(commandResult({ stdout: 'grok 0.2.101\n' }))

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ status: 'ready' }),
            expect.objectContaining({ status: 'ready' }),
        ])
        expect(versionCalls).toBe(1)

        await expect(service.probe('grok')).resolves.toMatchObject({ status: 'ready' })
        expect(versionCalls).toBe(2)
    })

    it('globally bounds concurrent provider probe commands', async () => {
        let active = 0
        let maximumActive = 0
        const service = createService({
            runCommand: async (spec) => {
                active += 1
                maximumActive = Math.max(maximumActive, active)
                await new Promise((resolve) => setTimeout(resolve, 20))
                try {
                    const flavor = AGENT_FLAVORS.find((candidate) => getProviderCommand(candidate, {
                        HOME: '/Users/example',
                    }) === spec.command) ?? 'claude'
                    if (spec.args[0] === '--version' || spec.args[0] === 'version') {
                        return commandResult({ stdout: versionOutput(flavor) })
                    }
                    return authStatusResult(spec)
                } finally {
                    active -= 1
                }
            },
        })

        await service.probeAll()

        expect(maximumActive).toBeGreaterThan(1)
        expect(maximumActive).toBeLessThanOrEqual(4)
    })

    it('aborts and awaits all owned provider probes during shutdown', async () => {
        let started = 0
        let aborted = 0
        const service = createService({
            runCommand: async (spec) => await new Promise<ProviderCommandResult>((resolve) => {
                started += 1
                const onAbort = () => {
                    aborted += 1
                    resolve(commandResult({ exitCode: null, errorCode: 'ABORTED' }))
                }
                spec.signal?.addEventListener('abort', onAbort, { once: true })
            }),
        }) as ProviderReadinessService & { shutdown?: () => Promise<void> }

        expect(typeof service.shutdown).toBe('function')
        if (!service.shutdown) return

        const probing = service.probeAll()
        await vi.waitFor(() => expect(started).toBe(4))
        const shutdown = service.shutdown()

        await expect(shutdown).resolves.toBeUndefined()
        await expect(probing).resolves.toBeDefined()
        expect(started).toBe(4)
        expect(aborted).toBe(4)
        await expect(service.probe('grok')).rejects.toThrow(/shut down/i)
    })

    it('gives a newer applied probe a strictly newer timestamp when the clock has not advanced', async () => {
        const readFile = vi.fn()
            .mockResolvedValueOnce(JSON.stringify({
                'https://accounts.x.ai/sign-in': { key: 'fixture-secret' },
            }))
            .mockResolvedValueOnce('{}')
        const service = createService({
            runCommand: async () => commandResult({ stdout: 'grok 0.2.101\n' }),
            readFile,
        })

        const ready = await service.probe('grok')
        const signedOut = await service.probe('grok')

        expect(ready).toMatchObject({ status: 'ready', checkedAt: START })
        expect(signedOut).toMatchObject({ status: 'not-authenticated' })
        expect(signedOut.checkedAt).toBeGreaterThan(ready.checkedAt)
        expect(service.snapshot().grok).toEqual(signedOut)
    })
})
