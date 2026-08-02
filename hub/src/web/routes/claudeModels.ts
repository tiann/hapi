import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { getSettingsFile, readSettings } from '../../config/settings'

/**
 * Custom Claude model names configured in settings.json
 * (`customClaudeModels`). Claude Code has no model catalog API like Codex,
 * so users routing Claude through a custom ANTHROPIC_BASE_URL list their
 * endpoint's model names here to surface them in the New Session picker.
 */
export function createClaudeModelsRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/claude/custom-models', async (c) => {
        const settings = await readSettings(getSettingsFile(dataDir))
        const models = Array.isArray(settings?.customClaudeModels)
            ? settings.customClaudeModels
            : []
        return c.json({ models })
    })

    return app
}
