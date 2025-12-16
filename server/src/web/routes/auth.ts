import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { validateTelegramInitData } from '../telegramInitData'
import type { WebAppEnv } from '../middleware/auth'

const authBodySchema = z.object({
    initData: z.string()
})

export function createAuthRoutes(jwtSecret: Uint8Array): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const initData = parsed.data.initData
        const result = validateTelegramInitData(initData, configuration.telegramBotToken)
        if (!result.ok) {
            return c.json({ error: result.error }, 401)
        }

        const telegramUserId = result.user.id
        if (!configuration.isChatIdAllowed(telegramUserId)) {
            return c.json({ error: 'User not allowed' }, 403)
        }

        const token = await new SignJWT({ uid: telegramUserId })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('15m')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: telegramUserId,
                username: result.user.username,
                firstName: result.user.first_name,
                lastName: result.user.last_name
            }
        })
    })

    return app
}

