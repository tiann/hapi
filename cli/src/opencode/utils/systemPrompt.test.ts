import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOpencodeConfig } from './opencodeConfig'
import { getOpencodeNativeToolInstruction, getTitleInstruction, TITLE_INSTRUCTION } from './systemPrompt'

const SCOPE_BULLET = "- Use them for files you created, or found on the user's behalf, that the user has not been shown. Files the user attached, pasted, or pointed you to are already visible to them, so do not display those again unless the user asks."

const BLOCK_HEADER = 'HAPI display tools (display_image, display_video, display_media) show a local file to the user in the HAPI chat.'

function expectDisplayToolsBlockOnce(text: string): void {
    expect(text.split(BLOCK_HEADER)).toHaveLength(2)
    for (const tool of ['display_image', 'display_video', 'display_media']) {
        expect(text).toContain(tool)
    }
    expect(text).toContain('`await tools.hapi.<tool>({ path })`')
    expect(text.split(SCOPE_BULLET)).toHaveLength(2)
    expect(text).toContain('`execute`')
}

describe('OpenCode local HAPI instructions', () => {
    let configDirectory: string | null = null

    afterEach(async () => {
        if (configDirectory) {
            await rm(configDirectory, { recursive: true, force: true })
            configDirectory = null
        }
    })

    it('writes the skill lookup instruction into the configured system prompt', async () => {
        configDirectory = await mkdtemp(join(tmpdir(), 'hapi-opencode-prompt-'))
        const { instructionsPath } = ensureOpencodeConfig(
            configDirectory,
            { command: 'hapi', args: ['mcp'] },
            TITLE_INSTRUCTION
        )

        const instructions = await readFile(instructionsPath, 'utf8')
        expect(instructions).toContain('$name')
        expect(instructions).toContain('skill_lookup')
    })
})

describe('OpenCode ACP title and peer instructions', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
        vi.resetModules()
    })

    it.each([false, true])('keeps change_title available when peer tools are disabled=%s', async (disabled) => {
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', disabled ? '1' : '')
        vi.resetModules()
        const { TITLE_INSTRUCTION, OPENCODE_NATIVE_TOOL_INSTRUCTION } = await import('./systemPrompt')

        for (const prompt of [TITLE_INSTRUCTION, OPENCODE_NATIVE_TOOL_INSTRUCTION]) {
            expect(prompt).toContain('hapi_change_title')
            expect(prompt).toContain('hapi_<tool>')
            expect(prompt).toContain('skill_lookup')
            for (const tool of ['hapi_list_peers', 'hapi_inspect_peer', 'hapi_ping_peer']) {
                if (disabled) {
                    expect(prompt).not.toContain(tool)
                } else {
                    expect(prompt).toContain(tool)
                }
            }
        }
    })
})

describe('OpenCode display tools block', () => {
    it('appears once in the local hapi-instructions.md', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-opencode-display-'))
        try {
            const { instructionsPath } = ensureOpencodeConfig(dir, { command: 'hapi', args: ['mcp'] }, getTitleInstruction({}))
            expectDisplayToolsBlockOnce(await readFile(instructionsPath, 'utf8'))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('appears once in the ACP first-prompt instruction', () => {
        expectDisplayToolsBlockOnce(getOpencodeNativeToolInstruction({}))
    })

    it('keeps the title and skill lookup instructions next to it', () => {
        for (const prompt of [getTitleInstruction({}), getOpencodeNativeToolInstruction({})]) {
            expect(prompt).toContain('hapi_change_title')
            expect(prompt).toContain('skill_lookup')
        }
    })
})
