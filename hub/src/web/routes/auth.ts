import { Hono } from 'hono'
import { PASSKEY_RP_ID } from '@hapi/protocol/passkey'
import { AuthRequestSchema } from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { cliTokenFingerprint, signWebJwt, verifyPasskeySession } from '../authTokens'

export function createAuthRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

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
        } else if ('passkeySession' in parsed.data) {
            // Refresh a passkey login. The backing credential must still exist
            // and must have been registered under the current CLI token.
            const session = await verifyPasskeySession(jwtSecret, parsed.data.passkeySession)
            const credential = session ? store.passkeys.get(session.credentialId) : null
            const fingerprint = cliTokenFingerprint(jwtSecret, getConfiguration().cliApiToken)
            if (
                !session
                || !credential
                || credential.rpId !== PASSKEY_RP_ID
                || credential.namespace !== session.namespace
                || !constantTimeEquals(credential.tokenFingerprint, fingerprint)
            ) {
                return c.json({ error: 'passkey_session_invalid' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = credential.namespace
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

        const token = await signWebJwt(jwtSecret, userId, namespace)

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
