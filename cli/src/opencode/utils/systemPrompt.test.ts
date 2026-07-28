import { afterEach, describe, expect, it } from 'vitest'
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
