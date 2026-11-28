import { describe, expect, it, vi } from 'vitest'
import { PEER_CONTACT_SUMMARY } from '@hapi/protocol/sessionCitation'

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
            expect(claudePrompt).not.toContain('read it with mcp__hapi__inspect_peer')

            expect(codex.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(codex.TITLE_INSTRUCTION).not.toContain('read it with functions.hapi__inspect_peer')

            expect(opencode.TITLE_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.TITLE_INSTRUCTION).not.toContain('read it with hapi_inspect_peer')

            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('are disabled on this machine')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).not.toContain('read it with hapi_inspect_peer')
            for (const prompt of [claudePrompt, codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).not.toContain(PEER_CONTACT_SUMMARY)
            }
        } finally {
            restore()
        }
    })

    it('leaves media delivery to tool contracts across flavors', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            for (const prompt of [claude.getSystemPrompt(), codex.getCodexSystemPrompt({}), opencode.getTitleInstruction({}), opencode.getOpencodeNativeToolInstruction({})]) {
                expect(prompt).not.toContain('display_image')
                expect(prompt).not.toContain('display_video')
                expect(prompt).not.toContain('display_media')
                expect(prompt).not.toContain('Web/PWA')
                expect(prompt).toContain('change_title')
                expect(prompt).toContain('hapi job run')
            }
        } finally {
            restore()
        }
    })

    it('keeps the citation tool steer by default', async () => {
        const { claude, codex, opencode, restore } = await importFlavorPrompts(false)
        try {
            expect(claude.getSystemPrompt()).toContain('read it with mcp__hapi__inspect_peer')
            expect(codex.TITLE_INSTRUCTION).toContain('read it with functions.hapi__inspect_peer')
            expect(opencode.TITLE_INSTRUCTION).toContain('read it with hapi_inspect_peer')
            expect(opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION).toContain('read it with hapi_inspect_peer')
            for (const prompt of [claude.getSystemPrompt(), codex.TITLE_INSTRUCTION, opencode.TITLE_INSTRUCTION, opencode.OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
                expect(prompt).toContain(PEER_CONTACT_SUMMARY)
                expect(prompt).not.toContain('auto (default)')
            }
        } finally {
            restore()
        }
    })
})
