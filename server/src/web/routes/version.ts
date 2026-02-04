import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'

interface VersionInfo {
    sha: string
    shortSha: string
    branch: string
    isDirty: boolean
    commitTime: string
    buildTime: string
}

let cachedVersion: VersionInfo | null = null

async function loadVersion(): Promise<VersionInfo> {
    if (cachedVersion) {
        return cachedVersion
    }

    try {
        // Load version.json using Bun's file API
        const file = Bun.file('../../../dist/version.json')
        const content = await file.text()
        cachedVersion = JSON.parse(content)
        return cachedVersion!
    } catch (error) {
        console.error('Failed to load version.json:', error)
        // Fallback version
        cachedVersion = {
            sha: 'unknown',
            shortSha: 'unknown',
            branch: 'unknown',
            isDirty: false,
            commitTime: new Date().toISOString(),
            buildTime: new Date().toISOString(),
        }
        return cachedVersion
    }
}

export function createVersionRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/version', async (c) => {
        const version = await loadVersion()
        return c.json(version)
    })

    return app
}
