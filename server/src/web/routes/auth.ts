import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../ownerId'
import { LarkClient } from '../../lark/larkClient'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

const telegramAuthSchema = z.object({
    initData: z.string()
})

const accessTokenAuthSchema = z.object({
    accessToken: z.string()
})

const larkAuthSchema = z.object({
    code: z.string()
})

const authBodySchema = z.union([telegramAuthSchema, accessTokenAuthSchema, larkAuthSchema])

export function createAuthRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
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
            const parsedToken = parseAccessToken(parsed.data.accessToken)
            if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = parsedToken.namespace
        } else if ('code' in parsed.data) {
            // Lark Authentication
            if (!configuration.larkEnabled || !configuration.larkAppId || !configuration.larkAppSecret) {
                return c.json({ error: 'Lark authentication is disabled.' }, 503)
            }

            try {
                const client = new LarkClient({
                    appId: configuration.larkAppId,
                    appSecret: configuration.larkAppSecret
                })
                const user = await client.validateAuthCode(parsed.data.code)
                
                // For MVP, we trust anyone who can authenticate with the configured Lark App.
                // In production, we should check against an allowlist.
                
                userId = await getOrCreateOwnerId()
                username = user.name || user.open_id
                firstName = user.name
                namespace = user.namespace
            } catch (e) {
                console.error('[Auth] Lark auth failed:', e)
                return c.json({ error: 'Lark authentication failed' }, 401)
            }
        } else {
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.getUser('telegram', telegramUserId)
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
            .setExpirationTime('15m')
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

    return app
}
