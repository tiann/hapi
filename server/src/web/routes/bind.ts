import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

const bindBodySchema = z.object({
    initData: z.string(),
    accessToken: z.string()
})

export function createBindRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/bind', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = bindBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const parsedToken = parseAccessToken(parsed.data.accessToken)
        if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid access token' }, 401)
        }
        const namespace = parsedToken.namespace

        if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
            return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
        }

        const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
        if (!result.ok) {
            return c.json({ error: result.error }, 401)
        }

        const telegramUserId = String(result.user.id)
        const existingUser = store.getUser('telegram', telegramUserId)
        if (existingUser && existingUser.namespace !== namespace) {
            return c.json({ error: 'already_bound' }, 409)
        }
        store.addUser('telegram', telegramUserId, namespace)

        const userId = await getOrCreateOwnerId()

        const token = await new SignJWT({ uid: userId, ns: namespace })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('15m')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username: result.user.username,
                firstName: result.user.first_name,
                lastName: result.user.last_name
            }
        })
    })

    return app
}
