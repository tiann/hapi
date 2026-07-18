import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import {
    createAccessTokenBindingFingerprint,
    resolveConfiguredAccessTokenNamespace,
    type AccessTokenNamespaceResolver,
} from '../../utils/accessToken'
import { configuration } from '../../configuration'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

const bindBodySchema = z.object({
    initData: z.string(),
    accessToken: z.string()
})

export type BindRouteOptions = {
    resolveAccessTokenNamespace?: AccessTokenNamespaceResolver
    getOwnerId?: () => Promise<number>
    telegramBotToken?: string | null
    validateTelegramInitData?: typeof validateTelegramInitData
}

export function createBindRoutes(
    jwtSecret: Uint8Array,
    store: Store,
    options: BindRouteOptions = {},
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const resolveAccessToken = options.resolveAccessTokenNamespace ?? resolveConfiguredAccessTokenNamespace
    const getOwnerId = options.getOwnerId ?? getOrCreateOwnerId
    const validateInitData = options.validateTelegramInitData ?? validateTelegramInitData

    app.post('/bind', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = bindBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = resolveAccessToken(parsed.data.accessToken)
        if (!namespace) {
            return c.json({ error: 'Invalid access token' }, 401)
        }
        const credentialFingerprint = createAccessTokenBindingFingerprint(parsed.data.accessToken, jwtSecret)
        if (!credentialFingerprint) {
            return c.json({ error: 'Invalid access token' }, 401)
        }

        const telegramBotToken = options.telegramBotToken === undefined
            ? configuration.telegramBotToken
            : options.telegramBotToken
        if (!telegramBotToken) {
            return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
        }

        const result = validateInitData(parsed.data.initData, telegramBotToken)
        if (!result.ok) {
            return c.json({ error: result.error }, 401)
        }

        const telegramUserId = String(result.user.id)
        const existingUser = store.users.getUser('telegram', telegramUserId)
        if (existingUser && existingUser.namespace !== namespace) {
            return c.json({ error: 'already_bound' }, 409)
        }
        store.users.addUser('telegram', telegramUserId, namespace, credentialFingerprint)

        const userId = await getOwnerId()

        const token = await new SignJWT({ uid: userId, ns: namespace })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
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
