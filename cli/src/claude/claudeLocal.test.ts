import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    spawn: vi.fn(async (_opts: unknown) => {}),
    claudeCheckSession: vi.fn(() => true)
}))

vi.mock('node:fs', () => ({
    mkdirSync: vi.fn()
}))

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}))

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: harness.claudeCheckSession
}))

vi.mock('./utils/path', () => ({
    getProjectPath: () => '/tmp/claude-project'
}))

vi.mock('./utils/mcpConfig', () => ({
    appendMcpConfigArg: () => undefined
}))

vi.mock('./utils/systemPrompt', () => ({
    getSystemPrompt: () => 'HAPI system prompt'
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: harness.spawn
}))

vi.mock('@/constants/uploadPaths', () => ({
    getHapiBlobsDir: () => '/tmp/hapi-blobs'
}))

vi.mock('@/utils/shellEscape', () => ({
    stripNewlinesForWindowsShellArg: (value: string) => value
}))

vi.mock('./sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}))

import { ClaudeResumeUnavailableError } from './utils/claudeResumeUnavailableError'
import { claudeLocal } from './claudeLocal'

function getSpawnArgs(): string[] {
    const call = harness.spawn.mock.calls[0]
    expect(call).toBeDefined()
    return (call[0] as { args: string[] }).args
}

describe('claudeLocal model arguments', () => {
    beforeEach(() => {
        harness.spawn.mockClear()
        harness.claudeCheckSession.mockReset()
        harness.claudeCheckSession.mockReturnValue(true)
    })

    it('launches Claude with the current session model', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            model: 'claude-opus-4-1'
        })

        expect(getSpawnArgs()).toEqual([
            '--append-system-prompt', 'HAPI system prompt',
            '--model', 'claude-opus-4-1',
            '--settings', '/tmp/hooks.json',
            '--add-dir', '/tmp/hapi-blobs'
        ])
    })

    it('replaces a stale startup model with the current session model', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--model', 'claude-haiku-4-5', '--verbose'],
            model: 'claude-opus-4-1'
        })

        const args = getSpawnArgs()
        expect(args).not.toContain('claude-haiku-4-5')
        expect(args).toContain('--verbose')
        expect(args.filter((arg) => arg === '--model')).toHaveLength(1)
        expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
            '--model', 'claude-opus-4-1'
        ])
    })

    it('removes a stale startup model when the session returns to the default', async () => {
        await claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--model=claude-haiku-4-5', '--verbose'],
            model: null
        })

        const args = getSpawnArgs()
        expect(args).not.toContain('--model=claude-haiku-4-5')
        expect(args).not.toContain('--model')
        expect(args).toContain('--verbose')
    })
})

describe('claudeLocal resume probe (#1933)', () => {
    beforeEach(() => {
        harness.spawn.mockClear()
        harness.claudeCheckSession.mockReset()
        harness.claudeCheckSession.mockReturnValue(true)
    })

    it('throws resume_unavailable for an explicit --resume target missing on disk', async () => {
        harness.claudeCheckSession.mockReturnValue(false)

        await expect(claudeLocal({
            abort: new AbortController().signal,
            sessionId: null,
            path: '/workspace',
            hookSettingsPath: '/tmp/hooks.json',
            claudeArgs: ['--resume', 'c66b46bc-7647-491a-9cd4-06ba640b9910']
        })).rejects.toMatchObject({
            name: 'ClaudeResumeUnavailableError',
            code: 'resume_unavailable',
            resumeSessionId: 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        } satisfies Partial<ClaudeResumeUnavailableError>)

        expect(harness.spawn).not.toHaveBeenCalled()
        expect(harness.claudeCheckSession).toHaveBeenCalledWith(
            'c66b46bc-7647-491a-9cd4-06ba640b9910',
            '/workspace'
        )
    })
})
