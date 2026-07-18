import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { configuration } from '../../configuration'
import {
    createConfiguredAccessTokenBindingValidator,
    resolveConfiguredAccessTokenNamespace,
    type AccessTokenBindingValidator,
    type AccessTokenNamespaceResolver,
} from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'

const telegramAuthSchema = z.object({
    initData: z.string()
})

const accessTokenAuthSchema = z.object({
    accessToken: z.string()
})

const authBodySchema = z.union([telegramAuthSchema, accessTokenAuthSchema])

export type AuthRouteOptions = {
    resolveAccessTokenNamespace?: AccessTokenNamespaceResolver
    getOwnerId?: () => Promise<number>
    telegramBotToken?: string | null
    validateTelegramInitData?: typeof validateTelegramInitData
    isTelegramBindingCurrent?: AccessTokenBindingValidator
}

export function createAuthRoutes(
    jwtSecret: Uint8Array,
    store: Store,
    options: AuthRouteOptions = {},
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const resolveAccessToken = options.resolveAccessTokenNamespace ?? resolveConfiguredAccessTokenNamespace
    const getOwnerId = options.getOwnerId ?? getOrCreateOwnerId
    const validateInitData = options.validateTelegramInitData ?? validateTelegramInitData
    const isTelegramBindingCurrent = options.isTelegramBindingCurrent
        ?? createConfiguredAccessTokenBindingValidator(jwtSecret)

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
            const resolvedNamespace = resolveAccessToken(parsed.data.accessToken)
            if (!resolvedNamespace) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOwnerId()
            firstName = 'Web User'
            namespace = resolvedNamespace
        } else {
            const telegramBotToken = options.telegramBotToken === undefined
                ? configuration.telegramBotToken
                : options.telegramBotToken
            if (!telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateInitData(parsed.data.initData, telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser || !isTelegramBindingCurrent(storedUser)) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOwnerId()
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

    return app
}
