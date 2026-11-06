import { describe, expect, it } from 'vitest'
import { HAPI_MCP_BRIDGE_PROMPT } from './hapiMcpBridgePrompt'
import {
    DISPLAY_IMAGE_PROMPT_CLAUDE,
    DISPLAY_IMAGE_PROMPT_CODEX,
    DISPLAY_IMAGE_PROMPT_CURSOR,
    DISPLAY_MEDIA_PROMPT_CLAUDE,
    DISPLAY_MEDIA_PROMPT_CODEX,
    DISPLAY_MEDIA_PROMPT_CURSOR,
    DISPLAY_TOOLS_PROMPT_HAPI_MCP,
    DISPLAY_VIDEO_PROMPT_CLAUDE,
    DISPLAY_VIDEO_PROMPT_CODEX,
    DISPLAY_VIDEO_PROMPT_CURSOR,
} from './displayImagePrompt'

const displayImagePrompts = [
    DISPLAY_IMAGE_PROMPT_CLAUDE,
    DISPLAY_IMAGE_PROMPT_CODEX,
    DISPLAY_IMAGE_PROMPT_CURSOR,
]

describe('display_image prompt semantics', () => {
    it('describes image display as agent-to-user output, not model image input', () => {
        for (const prompt of displayImagePrompts) {
            expect(prompt).toContain('human user')
            expect(prompt).toContain('absolute filesystem path')
            expect(prompt).toContain('sends the image to the human user')
            expect(prompt).toContain('does not provide image input to the model')
            expect(prompt).toContain('cannot be used to read, inspect, or analyze image contents')
        }
    })

    it('keeps each agent flavor instruction pointed at the corresponding tool alias', () => {
        expect(DISPLAY_IMAGE_PROMPT_CLAUDE).toContain('mcp__hapi__display_image')
        expect(DISPLAY_IMAGE_PROMPT_CODEX).toContain('functions.hapi__display_image')
        expect(DISPLAY_IMAGE_PROMPT_CURSOR).toContain('"display_image"')
    })
})

const SCOPE_BULLET = "- Use them for files you created, or found on the user's behalf, that the user has not been shown. Files the user attached, pasted, or pointed you to are already visible to them, so do not display those again unless the user asks."

const BLOCK_HEADER = 'HAPI display tools (display_image, display_video, display_media) show a local file to the user in the HAPI chat.'

function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1
}

describe('HAPI display tools block (OpenCode)', () => {
    it('names all three tools once and explains the direct and Code Mode calls', () => {
        expect(countOccurrences(DISPLAY_TOOLS_PROMPT_HAPI_MCP, BLOCK_HEADER)).toBe(1)
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('hapi_<tool>')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('tools.hapi.<tool>')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('`await tools.hapi.<tool>({ path })`')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('`execute`')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('Do not guess other names')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP.indexOf('hapi_<tool>')).toBeLessThan(DISPLAY_TOOLS_PROMPT_HAPI_MCP.indexOf('tools.hapi.<tool>'))
    })

    it('limits the tools to files the user has not been shown, unless the user asks', () => {
        expect(countOccurrences(DISPLAY_TOOLS_PROMPT_HAPI_MCP, SCOPE_BULLET)).toBe(1)
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('unless the user asks')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).not.toContain('never')
        const bullets = DISPLAY_TOOLS_PROMPT_HAPI_MCP.split('\n')
        expect(bullets[1]).toBe(SCOPE_BULLET)
        expect(countOccurrences(HAPI_MCP_BRIDGE_PROMPT, SCOPE_BULLET)).toBe(1)
    })

    it('says display_image only shows the image to the user', () => {
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).toContain('display_image only shows the image to the user; it does not let you see or analyze it.')
    })

    it('does not advertise aliases that OpenCode may not expose', () => {
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).not.toContain('mcp__hapi__')
        expect(DISPLAY_TOOLS_PROMPT_HAPI_MCP).not.toContain('equivalent alias')
    })

    it('is part of the bridge prompt exactly once', () => {
        expect(countOccurrences(HAPI_MCP_BRIDGE_PROMPT, BLOCK_HEADER)).toBe(1)
    })
})

describe('display prompts for other agents', () => {
    it('keep their own tool names and never mention Code Mode', () => {
        const others = [
            DISPLAY_IMAGE_PROMPT_CLAUDE, DISPLAY_VIDEO_PROMPT_CLAUDE, DISPLAY_MEDIA_PROMPT_CLAUDE,
            DISPLAY_IMAGE_PROMPT_CODEX, DISPLAY_VIDEO_PROMPT_CODEX, DISPLAY_MEDIA_PROMPT_CODEX,
            DISPLAY_IMAGE_PROMPT_CURSOR, DISPLAY_VIDEO_PROMPT_CURSOR, DISPLAY_MEDIA_PROMPT_CURSOR,
        ]
        for (const prompt of others) {
            expect(prompt).not.toContain('Code Mode')
            expect(prompt).not.toContain('tools.hapi.')
            expect(prompt).not.toContain('`execute`')
            expect(prompt).not.toContain('already visible to them')
        }
        expect(DISPLAY_VIDEO_PROMPT_CLAUDE).toContain('mcp__hapi__display_video')
        expect(DISPLAY_MEDIA_PROMPT_CODEX).toContain('functions.hapi__display_media')
        expect(DISPLAY_MEDIA_PROMPT_CURSOR).toContain('"display_media"')
    })
})
