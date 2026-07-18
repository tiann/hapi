import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { ensureCliArtifact, readArtifactMeta } from '../../upgrade/cliArtifact'
import { defaultHubPackageRoot, resolveUpgradeOffer } from '../../upgrade/resolveUpgradeOffer'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

/**
 * Web (JWT) routes: upgrade offer for the UI.
 */
export function createUpgradeRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/upgrade/offer', (c) => {
        const offer = resolveUpgradeOffer({
            hubPackageRoot: defaultHubPackageRoot(),
            execPath: process.execPath,
        })
        return c.json({ offer })
    })

    return app
}

type CliEnv = {
    Variables: {
        namespace: string
    }
}

/**
 * CLI-token routes: binary artifact download for runner-self-upgrade.
 * Mounted at `/cli` (same auth as other CLI HTTP routes).
 */
export function createUpgradeCliRoutes(): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('/upgrade/*', async (c, next) => {
        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }
        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }
        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const configuration = getConfiguration()
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }
        c.set('namespace', parsedToken.namespace)
        await next()
        return
    })

    app.get('/upgrade/cli-artifact', async (c) => {
        const config = getConfiguration()
        const version = c.req.query('version')
        const platform = c.req.query('platform') || process.platform
        const arch = c.req.query('arch') || process.arch

        const baseOffer = resolveUpgradeOffer({
            hubPackageRoot: defaultHubPackageRoot(),
            execPath: process.execPath,
        })
        const targetVersion = version || baseOffer.targetVersion

        if (baseOffer.channel === 'off') {
            return c.json({ error: 'Fleet upgrade disabled' }, 403)
        }

        try {
            let meta = readArtifactMeta(targetVersion, platform, arch, config.dataDir)
            if (!meta) {
                meta = await ensureCliArtifact({
                    version: targetVersion,
                    platform,
                    arch,
                    dataDir: config.dataDir,
                    hubPackageRoot: defaultHubPackageRoot(),
                })
            }
            if (!existsSync(meta.path)) {
                return c.json({ error: 'Artifact missing on disk' }, 404)
            }

            c.header('Content-Type', 'application/octet-stream')
            c.header('Content-Disposition', `attachment; filename="hapi-${meta.version}"`)
            c.header('X-Hapi-Artifact-Sha256', meta.sha256)
            c.header('X-Hapi-Artifact-Version', meta.version)
            return new Response(Bun.file(meta.path), {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="hapi-${meta.version}"`,
                    'X-Hapi-Artifact-Sha256': meta.sha256,
                    'X-Hapi-Artifact-Version': meta.version,
                },
            })
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to build artifact',
            }, 503)
        }
    })

    return app
}
