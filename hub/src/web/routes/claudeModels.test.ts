import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeModelsRoutes } from './claudeModels'

describe('Claude custom models route', () => {
    let dataDir: string | null = null

    afterEach(() => {
        if (dataDir) {
            rmSync(dataDir, { recursive: true, force: true })
            dataDir = null
        }
    })

    it('returns trimmed unique model names and drops malformed values', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'hapi-claude-models-test-'))
        writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
            customClaudeModels: [
                ' deepseek-v4-flash[1m] ',
                'deepseek-v4-flash[1m]',
                '',
                42,
                null
            ]
        }))
        const app = createClaudeModelsRoutes(dataDir)

        const response = await app.request('/claude/custom-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ models: ['deepseek-v4-flash[1m]'] })
    })
})
