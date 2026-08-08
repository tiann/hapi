import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import { FLEET_UPGRADE_POLICIES } from '@hapi/protocol/upgradeChannel'
import type { WebAppEnv } from '../middleware/auth'
import { ensureCliArtifact, findArtifactMetaBySha256 } from '../../upgrade/cliArtifact'
import { defaultHubPackageRoot, resolveUpgradeOffer } from '../../upgrade/resolveUpgradeOffer'
import { getFleetUpgradePolicy, setFleetUpgradePolicy } from '../../upgrade/fleetUpgradePolicy'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { SyncEngine } from '../../sync/syncEngine'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

/**
 * Web (JWT) routes: upgrade offer for the UI.
 */
export function createUpgradeRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/upgrade/offer', (c) => {
        const engine = getSyncEngine()
        const offer = engine?.getHubUpgradeOffer()
        if (!offer) {
            // Fallback for early boot / tests without a SyncEngine — still
            // resolves a channel/version without forcing a fingerprint walk
            // when the engine cache is available.
            const fallback = resolveUpgradeOffer({
                hubPackageRoot: defaultHubPackageRoot(),
                execPath: process.execPath,
            })
            return c.json({ offer: fallback, policy: getFleetUpgradePolicy() })
        }
        return c.json({ offer, policy: getFleetUpgradePolicy() })
    })

    const policyBody = z.object({ policy: z.enum(FLEET_UPGRADE_POLICIES as unknown as [string, ...string[]]) })

    app.put('/upgrade/policy', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Fleet upgrade policy is only available in the default namespace' }, 403)
        }
        const parsed = policyBody.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid policy' }, 400)
        }
        try {
            await setFleetUpgradePolicy(parsed.data.policy as (typeof FLEET_UPGRADE_POLICIES)[number])
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update fleet upgrade policy'
            return c.json({ error: message }, 500)
        }
        return c.json({ policy: getFleetUpgradePolicy() })
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

        // Only serve the hub's current offer version — prevents arbitrary-version
        // compiles and keeps path tokens aligned with a known semver.
        if (targetVersion !== baseOffer.targetVersion) {
            return c.json({ error: 'Unsupported artifact version' }, 400)
        }

        try {
            const wantedSha = c.req.query('sha256')
            if (wantedSha) {
                // Digest-pinned offer: serve the retained bytes only. Do not
                // rebuild — a newer generation would fail the runner's sha check.
                const retained = findArtifactMetaBySha256(wantedSha, config.dataDir)
                if (!retained || !existsSync(retained.path)) {
                    return c.json({ error: 'Artifact not retained for digest' }, 404)
                }
                if (retained.version !== targetVersion) {
                    return c.json({ error: 'Artifact digest does not match offer version' }, 400)
                }
                c.header('Content-Type', 'application/octet-stream')
                c.header('Content-Disposition', `attachment; filename="hapi-${retained.version}"`)
                c.header('X-Hapi-Artifact-Sha256', retained.sha256)
                c.header('X-Hapi-Artifact-Version', retained.version)
                return new Response(Bun.file(retained.path), {
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Disposition': `attachment; filename="hapi-${retained.version}"`,
                        'X-Hapi-Artifact-Sha256': retained.sha256,
                        'X-Hapi-Artifact-Version': retained.version,
                    },
                })
            }

            // Unpinned: ensureCliArtifact refuses same-version stale caches via sourceFingerprint.
            const meta = await ensureCliArtifact({
                version: targetVersion,
                platform,
                arch,
                dataDir: config.dataDir,
                hubPackageRoot: defaultHubPackageRoot(),
            })
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
            const message = error instanceof Error ? error.message : 'Failed to build artifact'
            if (message.startsWith('Invalid artifact ')) {
                return c.json({ error: message }, 400)
            }
            return c.json({ error: message }, 503)
        }
    })

    return app
}
