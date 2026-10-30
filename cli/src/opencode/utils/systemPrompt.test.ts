import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOpencodeConfig } from './opencodeConfig'
import { TITLE_INSTRUCTION } from './systemPrompt'

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
            expect(prompt).toContain('hapi_display_image')
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
