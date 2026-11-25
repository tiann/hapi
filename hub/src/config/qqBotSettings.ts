import type { QqBotCredentials } from '../qqbot/client'

export type QqBotFileSettings = {
    enabled?: boolean
    appId?: string
    appSecret?: string
    userOpenId?: string
    namespace?: string
    backgroundOnly?: boolean
}

export type QqBotOptions = QqBotCredentials & {
    namespace: string
    backgroundOnly: boolean
}

export function resolveQqBotSettings(
    file: QqBotFileSettings | undefined,
    env: NodeJS.ProcessEnv,
    publicUrl: string | undefined
): QqBotOptions | null {
    const enabled = readBoolean(env.QQBOT_NOTIFICATION, file?.enabled, 'QQBOT_NOTIFICATION / qqBot.enabled')
    if (!enabled) return null

    const appId = readRequiredString(env.QQBOT_APP_ID ?? file?.appId, 'QQBOT_APP_ID / qqBot.appId', /^\d+$/)
    const appSecret = readRequiredString(env.QQBOT_APP_SECRET ?? file?.appSecret, 'QQBOT_APP_SECRET / qqBot.appSecret', /^\S+$/)
    const userOpenId = readRequiredString(env.QQBOT_USER_OPENID ?? file?.userOpenId, 'QQBOT_USER_OPENID / qqBot.userOpenId', /^[A-Za-z0-9_-]+$/)
    const namespace = readRequiredString(env.QQBOT_NAMESPACE ?? file?.namespace ?? 'default', 'QQBOT_NAMESPACE / qqBot.namespace', /^[^:\s]+$/)
    const backgroundOnly = readBoolean(env.QQBOT_BACKGROUND_ONLY, file?.backgroundOnly, 'QQBOT_BACKGROUND_ONLY / qqBot.backgroundOnly')

    if (!publicUrl) throw new Error('QQ Bot notifications require an explicit HAPI_PUBLIC_URL / publicUrl')
    let url: URL
    try {
        url = new URL(publicUrl)
    } catch {
        throw new Error('QQ Bot notifications require a valid HTTP(S) HAPI_PUBLIC_URL / publicUrl')
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('QQ Bot notifications require an HTTP(S) HAPI_PUBLIC_URL / publicUrl without credentials')
    }
    return { appId, appSecret, userOpenId, namespace, backgroundOnly }
}

function readBoolean(env: string | undefined, file: boolean | undefined, field: string): boolean {
    if (env !== undefined) {
        if (env === 'true') return true
        if (env === 'false') return false
        throw new Error(`${field} must be true or false`)
    }
    if (file === undefined || typeof file === 'boolean') return file ?? false
    throw new Error(`${field} must be a boolean`)
}

function readRequiredString(input: unknown, field: string, pattern: RegExp): string {
    const value = typeof input === 'string' ? input.trim() : ''
    if (!pattern.test(value)) throw new Error(`${field} is required and must be valid when QQ Bot notifications are enabled`)
    return value
}
