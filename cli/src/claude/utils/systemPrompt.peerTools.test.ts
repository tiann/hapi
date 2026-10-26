import { describe, expect, it, vi } from 'vitest'

/**
 * Peer-tools citation steer across all three flavors.
 *
 * The gate is resolved either at import time (citation block baked into
 * module-level prompt consts, feature shape) or at call time
 * (getSystemPrompt(env) resolving per call, stack shape). Setting the env
 * before import AND keeping it set through the assertions covers both
 * shapes; each mode re-imports the modules fresh via vi.resetModules().
 */
async function importFlavorPrompts(disabled: boolean) {
    vi.resetModules()
    const prev = process.env.HAPI_DISABLE_PEER_TOOLS
    if (disabled) process.env.HAPI_DISABLE_PEER_TOOLS = '1'
    else delete process.env.HAPI_DISABLE_PEER_TOOLS
    const [claude, codex, opencode] = await Promise.all([
        import('./systemPrompt'),
        import('../../codex/utils/systemPrompt'),
        import('../../opencode/utils/systemPrompt'),
    ])
    const restore = () => {
        if (prev === undefined) delete process.env.HAPI_DISABLE_PEER_TOOLS
        else process.env.HAPI_DISABLE_PEER_TOOLS = prev
    }
    return { claude, codex, opencode, restore }
}

describe('peer-tools citation steer across flavors', () => {
    it('replaces the citation tool steer with the disabled notice when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(true)
        try {
            const claudePrompt = claude.getSystemPrompt()
            expect(claudePrompt).toContain('are disabled on this machine')
            expect(claudePrompt).not.toContain('Call "mcp__hapi__inspect_peer"')

            expect(codex.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(codex.TITLE_INSTRUCTION).not.toContain('Call "functions.hapi__inspect_peer"')

            expect(opencode.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.TITLE_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')

            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).not.toContain('Call "hapi_inspect_peer"')
        } finally {
            restore()
        }
    })

    it('keeps the citation tool steer by default', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            expect(claude.getSystemPrompt()).toContain('Call "mcp__hapi__inspect_peer"')
            expect(codex.TITLE_INSTRUCTION).toContain('Call "functions.hapi__inspect_peer"')
            expect(opencode.TITLE_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('Call "hapi_inspect_peer"')
        } finally {
            restore()
        }
    })
})
