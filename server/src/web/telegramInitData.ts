import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const telegramUserSchema = z.object({
    id: z.number(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional()
})

export type TelegramUser = z.infer<typeof telegramUserSchema>

export type TelegramInitDataValidation =
    | { ok: true; user: TelegramUser; authDate: number; raw: Record<string, string> }
    | { ok: false; error: string }

function computeDataCheckString(entries: Record<string, string>): string {
    const keys = Object.keys(entries)
        .filter((key) => key !== 'hash')
        .sort((a, b) => a.localeCompare(b))

    return keys.map((key) => `${key}=${entries[key] ?? ''}`).join('\n')
}

function safeCompareHex(aHex: string, bHex: string): boolean {
    try {
        const a = Buffer.from(aHex, 'hex')
        const b = Buffer.from(bHex, 'hex')
        if (a.length !== b.length) {
            return false
        }
        return timingSafeEqual(a, b)
    } catch {
        return false
    }
}

function deriveSecretKeys(botToken: string): Uint8Array[] {
    const hmacKeyConstThenToken = createHmac('sha256', 'WebAppData').update(botToken).digest()
    const hmacKeyTokenThenConst = createHmac('sha256', botToken).update('WebAppData').digest()
    const shaBotToken = createHash('sha256').update(botToken).digest()
    return [
        new Uint8Array(hmacKeyConstThenToken),
        new Uint8Array(hmacKeyTokenThenConst),
        new Uint8Array(shaBotToken)
    ]
}

function computeExpectedHashHex(secretKey: Uint8Array, dataCheckString: string): string {
    return createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
}

export function validateTelegramInitData(
    initData: string,
    botToken: string,
    maxAgeSeconds: number = 60 * 60 * 24
): TelegramInitDataValidation {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    if (!hash) {
        return { ok: false, error: 'Missing hash' }
    }

    const entries: Record<string, string> = {}
    for (const [key, value] of params.entries()) {
        entries[key] = value
    }

    const authDateRaw = entries['auth_date']
    const authDate = authDateRaw ? parseInt(authDateRaw, 10) : NaN
    if (!Number.isFinite(authDate)) {
        return { ok: false, error: 'Missing or invalid auth_date' }
    }

    const nowSeconds = Math.floor(Date.now() / 1000)
    if (nowSeconds - authDate > maxAgeSeconds) {
        return { ok: false, error: 'initData is too old' }
    }

    const dataCheckString = computeDataCheckString(entries)
    const secretKeys = deriveSecretKeys(botToken)
    const isValid = secretKeys.some((secretKey) => safeCompareHex(hash, computeExpectedHashHex(secretKey, dataCheckString)))

    if (!isValid) {
        return { ok: false, error: 'Invalid initData signature' }
    }

    const userRaw = entries['user']
    if (!userRaw) {
        return { ok: false, error: 'Missing user' }
    }

    let userJson: unknown
    try {
        userJson = JSON.parse(userRaw)
    } catch {
        return { ok: false, error: 'Invalid user JSON' }
    }

    const user = telegramUserSchema.safeParse(userJson)
    if (!user.success) {
        return { ok: false, error: 'Invalid user schema' }
    }

    return { ok: true, user: user.data, authDate, raw: entries }
}

