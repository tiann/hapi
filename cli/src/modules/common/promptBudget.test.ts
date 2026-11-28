import { afterEach, describe, expect, it, vi } from 'vitest'

// Attribution and the session summary are user opt-ins, not part of the default prompt.
vi.mock('@/claude/utils/claudeSettings', () => ({ shouldIncludeCoAuthoredBy: () => false }))

/**
 * Every session pays for this text. If a change needs more room, put the
 * guidance in the tool description it belongs to instead of raising the limit.
 */
const MAX_PROMPT_CHARS = 650

async function loadPrompts(peerToolsDisabled: boolean): Promise<Record<string, string>> {
    vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', peerToolsDisabled ? '1' : '')
    vi.stubEnv('HAPI_SESSION_SUMMARY_CONTRACT', 'off')
    vi.resetModules()
    const [claude, codex, opencode, grok] = await Promise.all([
        import('@/claude/utils/systemPrompt'),
        import('@/codex/utils/systemPrompt'),
        import('@/opencode/utils/systemPrompt'),
        import('@/grok/utils/systemPrompt')
    ])
    return {
        claude: claude.getSystemPrompt(),
        codex: codex.getCodexSystemPrompt(),
        opencodeLocal: opencode.getTitleInstruction(),
        opencodeRemote: opencode.getOpencodeNativeToolInstruction(),
        grok: grok.getGrokTitleInstruction()
    }
}

describe('default HAPI prompt budget', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
        vi.resetModules()
    })

    it.each([false, true])('stays within the limit with peer tools disabled=%s', async (disabled) => {
        for (const [flavor, prompt] of Object.entries(await loadPrompts(disabled))) {
            expect(prompt.length, `${flavor} prompt is ${prompt.length} chars`).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
            // A budget alone would also pass on an empty prompt.
            expect(prompt).toContain('change_title')
            expect(prompt).toContain('hapi job run')
        }
    })
})
