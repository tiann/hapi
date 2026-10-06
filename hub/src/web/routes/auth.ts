import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { AuthRequestSchema } from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { getCloudflareAccessVerifier, type CloudflareAccessVerifier } from '../cloudflareAccess'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

const HAPI_JWT_TTL_SECONDS = 4 * 3600

const NO_STORE: Record<string, string> = { 'Cache-Control': 'no-store' }

export function createAuthRoutes(
    jwtSecret: Uint8Array,
    store: Store,
    options: { cloudflareAccessVerifier?: CloudflareAccessVerifier | null } = {}
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const cloudflareAccessVerifier = options.cloudflareAccessVerifier !== undefined
        ? options.cloudflareAccessVerifier
        : getCloudflareAccessVerifier()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = AuthRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        let userId: number
        let username: string | undefined
        let firstName: string | undefined
        let lastName: string | undefined
        let namespace: string

        // Access Token authentication (CLI_API_TOKEN)
        if ('accessToken' in parsed.data) {
            const configuration = getConfiguration()
            const parsedToken = parseAccessToken(parsed.data.accessToken)
            if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = parsedToken.namespace
        } else {
            const configuration = getConfiguration()
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOrCreateOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
            namespace = storedUser.namespace
        }

        const token = await new SignJWT({ uid: userId, ns: namespace })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username,
                firstName,
                lastName
            }
        })
    })

    app.get('/auth/methods', (c) => {
        return c.json({ cloudflareAccess: cloudflareAccessVerifier !== null }, 200, NO_STORE)
    })

    app.get('/auth/cloudflare', async (c) => {
        if (!cloudflareAccessVerifier) {
            return c.json({ error: 'Cloudflare Access is not configured' }, 404, NO_STORE)
        }

        const assertion = c.req.header('Cf-Access-Jwt-Assertion')
        if (!assertion) {
            return c.json({ error: 'Missing Cloudflare Access assertion' }, 401, NO_STORE)
        }

        const verified = await cloudflareAccessVerifier.verify(assertion)
        if (verified.kind === 'forbidden') {
            return c.json({ error: 'Access denied' }, 403, NO_STORE)
        }
        if (verified.kind === 'unavailable') {
            return c.json({ error: 'Authentication service unavailable' }, 503, NO_STORE)
        }
        if (verified.kind !== 'ok') {
            return c.json({ error: 'Invalid Cloudflare Access assertion' }, 401, NO_STORE)
        }

        const userId = await getOrCreateOwnerId()
        const expiresAt = Math.min(
            Math.floor(Date.now() / 1000) + HAPI_JWT_TTL_SECONDS,
            verified.expiresAt
        )
        const token = await new SignJWT({
            uid: userId,
            ns: verified.namespace,
            authMethod: 'cloudflareAccess',
            cfAccessSub: verified.subject,
            cfAccessEmail: verified.email
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(expiresAt)
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                firstName: 'Web User'
            }
        }, 200, NO_STORE)
    })

    return app
}
