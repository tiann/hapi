import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: vi.fn()
}))

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}))

vi.mock('@/claude/sdk/utils', () => ({
    getDefaultClaudeCodePath: () => '/usr/bin/claude'
}))

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {}
}))

import { claudeCheckSession } from './utils/claudeCheckSession'
import { ClaudeResumeUnavailableError } from './utils/claudeResumeUnavailableError'
import { claudeRemote } from './claudeRemote'

describe('claudeRemote resume probe (#1933)', () => {
    beforeEach(() => {
        vi.mocked(claudeCheckSession).mockReset()
    })

    it('throws resume_unavailable instead of minting when transcript is missing', async () => {
        vi.mocked(claudeCheckSession).mockReturnValue(false)

        await expect(claudeRemote({
            sessionId: 'c66b46bc-7647-491a-9cd4-06ba640b9910',
            path: '/tmp/proj',
            allowedTools: [],
            hookSettingsPath: '/tmp/hooks.json',
            canCallTool: async () => ({ behavior: 'allow' } as never),
            nextMessage: async () => null,
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: () => {},
            claudeArgs: ['--resume', 'c66b46bc-7647-491a-9cd4-06ba640b9910']
        })).rejects.toMatchObject({
            name: 'ClaudeResumeUnavailableError',
            code: 'resume_unavailable',
            resumeSessionId: 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        } satisfies Partial<ClaudeResumeUnavailableError>)

        expect(claudeCheckSession).toHaveBeenCalledWith(
            'c66b46bc-7647-491a-9cd4-06ba640b9910',
            '/tmp/proj'
        )
    })

    it('applies CLAUDE_CONFIG_DIR before probing so custom config roots are visible', async () => {
        const previous = process.env.CLAUDE_CONFIG_DIR
        delete process.env.CLAUDE_CONFIG_DIR
        try {
            vi.mocked(claudeCheckSession).mockImplementation(() => {
                expect(process.env.CLAUDE_CONFIG_DIR).toBe('/tmp/custom-claude-config')
                return false
            })

            await expect(claudeRemote({
                sessionId: 'c66b46bc-7647-491a-9cd4-06ba640b9910',
                path: '/tmp/proj',
                allowedTools: [],
                hookSettingsPath: '/tmp/hooks.json',
                canCallTool: async () => ({ behavior: 'allow' } as never),
                nextMessage: async () => null,
                onReady: () => {},
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
                claudeEnvVars: { CLAUDE_CONFIG_DIR: '/tmp/custom-claude-config' }
            })).rejects.toMatchObject({
                name: 'ClaudeResumeUnavailableError',
                code: 'resume_unavailable'
            })

            expect(claudeCheckSession).toHaveBeenCalled()
        } finally {
            if (previous === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR
            } else {
                process.env.CLAUDE_CONFIG_DIR = previous
            }
        }
    })
})
