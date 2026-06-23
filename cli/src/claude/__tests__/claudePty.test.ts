import { afterEach, describe, expect, it, vi } from 'vitest'

// claudePty is a thin wrapper over the shared runAgentPty driver. Here we only
// verify it forwards the correct claude-specific options; the PTY behavior
// (spawn/ready/echo-submit/loop) is tested in runAgentPty.test.ts.
vi.mock('@/agent/runAgentPty', () => ({
    runAgentPty: vi.fn(async () => {}),
}))

vi.mock('@/lib', () => ({
    logger: { debug: vi.fn() },
}))

// Trust isolation is unit-tested in trustedConfigDir.test.ts; here we only
// verify claudePty wires it into the spawn env and cleans up afterwards.
vi.mock('@/claude/trustedConfigDir', () => ({
    prepareTrustedConfigDir: vi.fn(() => '/tmp/fake-cfg'),
    cleanupTrustedConfigDir: vi.fn(),
}))

import { claudePty } from '../claudePty'
import { runAgentPty } from '@/agent/runAgentPty'
import { cleanupTrustedConfigDir, prepareTrustedConfigDir } from '@/claude/trustedConfigDir'

type ClaudePtyOpts = Parameters<typeof claudePty>[0]

function makeOpts(overrides: Partial<ClaudePtyOpts> = {}): ClaudePtyOpts {
    return {
        sessionId: 'test-session',
        path: '/tmp/test',
        nextMessage: vi.fn(),
        onReady: vi.fn(),
        onMessage: vi.fn(),
        ...overrides,
    }
}

function lastCall() {
    const mock = vi.mocked(runAgentPty)
    return mock.mock.calls[mock.mock.calls.length - 1]![0]
}

describe('claudePty wrapper', () => {
    afterEach(() => {
        vi.mocked(runAgentPty).mockClear()
    })

    it('spawns the claude command', async () => {
        await claudePty(makeOpts())
        expect(runAgentPty).toHaveBeenCalled()
        expect(lastCall().command).toBe('claude')
        expect(lastCall().cwd).toBe('/tmp/test')
    })

    it('includes --settings <hookSettingsPath> when provided, preserving claudeArgs', async () => {
        await claudePty(makeOpts({ hookSettingsPath: '/tmp/hooks/h.json', claudeArgs: ['--model', 'opus'] }))
        const args = lastCall().args
        const idx = args.indexOf('--settings')
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(args[idx + 1]).toBe('/tmp/hooks/h.json')
        expect(args).toEqual(expect.arrayContaining(['--model', 'opus']))
    })

    it('omits --settings when no hookSettingsPath', async () => {
        await claudePty(makeOpts({ claudeArgs: ['--model', 'opus'] }))
        expect(lastCall().args).not.toContain('--settings')
    })

    it('passes claude prompt + trust markers and DISABLE_AUTOUPDATER', async () => {
        await claudePty(makeOpts())
        expect(lastCall().promptMarkers).toEqual(expect.arrayContaining(['for shortcuts']))
        // '❯' must NOT be a prompt marker — it appears in the trust screen too.
        expect(lastCall().promptMarkers).not.toContain('❯')
        expect(lastCall().trustMarkers).toEqual(expect.arrayContaining(['trust this folder']))
        expect(lastCall().extraEnv).toMatchObject({ DISABLE_AUTOUPDATER: '1' })
    })

    it('drops inherited CLAUDECODE / CLAUDE_CODE_* but preserves the OAuth token', async () => {
        const prev = { ...process.env }
        process.env.CLAUDECODE = '1'
        process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'dummy-test-token'
        try {
            await claudePty(makeOpts())
            const unset = lastCall().unsetEnv ?? []
            expect(unset).toEqual(expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']))
            // The runner passes per-session auth via CLAUDE_CODE_OAUTH_TOKEN; it
            // must survive into the PTY child or the session starts unauthenticated.
            expect(unset).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
        } finally {
            process.env = prev
        }
    })

    it('forwards callbacks and signal', async () => {
        const nextMessage = vi.fn()
        const onReady = vi.fn()
        const onMessage = vi.fn()
        const onExit = vi.fn()
        const controller = new AbortController()
        await claudePty(makeOpts({ nextMessage, onReady, onMessage, onExit, signal: controller.signal }))
        const call = lastCall()
        expect(call.nextMessage).toBe(nextMessage)
        expect(call.onReady).toBe(onReady)
        expect(call.onMessage).toBe(onMessage)
        expect(call.onExit).toBe(onExit)
        expect(call.signal).toBe(controller.signal)
    })

    it('passes claudeEnvVars as envVars', async () => {
        await claudePty(makeOpts({ claudeEnvVars: { FOO: 'bar' } }))
        expect(lastCall().envVars).toEqual({ FOO: 'bar' })
    })

    it('isolates folder trust via CLAUDE_CONFIG_DIR and cleans up after', async () => {
        await claudePty(makeOpts({ path: '/work/dir' }))
        expect(prepareTrustedConfigDir).toHaveBeenCalledWith('/work/dir')
        expect(lastCall().extraEnv).toMatchObject({ CLAUDE_CONFIG_DIR: '/tmp/fake-cfg' })
        expect(cleanupTrustedConfigDir).toHaveBeenCalledWith('/tmp/fake-cfg')
    })
})
