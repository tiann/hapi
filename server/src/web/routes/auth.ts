import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../ownerId'
import type { WebAppEnv } from '../middleware/auth'

const telegramAuthSchema = z.object({
    initData: z.string()
})

const accessTokenAuthSchema = z.object({
    accessToken: z.string()
})

const authBodySchema = z.union([telegramAuthSchema, accessTokenAuthSchema])

export function createAuthRoutes(jwtSecret: Uint8Array): Hono<WebAppEnv> {
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

        // Access Token authentication (CLI_API_TOKEN)
        if ('accessToken' in parsed.data) {
            if (!safeCompareStrings(parsed.data.accessToken, configuration.cliApiToken)) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
        } else {
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            if (configuration.allowedChatIds.length === 0) {
                return c.json({ error: 'Telegram allowlist is empty. Configure ALLOWED_CHAT_IDS and restart.' }, 403)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = result.user.id
            if (!configuration.isChatIdAllowed(telegramUserId)) {
                return c.json({ error: 'User not allowed' }, 403)
            }

            userId = await getOrCreateOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
        }

        const token = await new SignJWT({ uid: userId })
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
