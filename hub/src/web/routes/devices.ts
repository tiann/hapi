import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const PUSH_KEY_BYTES = 32

/**
 * Strict base64 -> exactly 32 bytes, or null. `Buffer.from(_, 'base64')`
 * silently skips invalid characters, so an alphabet check comes first -
 * otherwise garbage like `"!!!!" + 43 chars` could sneak past the length
 * gate and register an undecryptable key.
 */
function decodePushKey(pushKey: string): Buffer | null {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pushKey)) {
        return null
    }
    const decoded = Buffer.from(pushKey, 'base64')
    return decoded.length === PUSH_KEY_BYTES ? decoded : null
}

const registerSchema = z.object({
    token: z.string().min(1),
    platform: z.enum(['phone', 'wear', 'ios']),
    deviceId: z.string().min(1).max(128),
    /**
     * iOS only (PUSH SPEC v1): base64 of 32 device-generated random bytes,
     * the E2E envelope key. Required when platform is "ios"; ignored for
     * phone/wear.
     */
    pushKey: z.string().optional()
}).superRefine((data, ctx) => {
    if (data.platform !== 'ios') {
        return
    }
    if (!data.pushKey || decodePushKey(data.pushKey) === null) {
        ctx.addIssue({
            code: 'custom',
            path: ['pushKey'],
            message: 'platform "ios" requires pushKey: base64 of exactly 32 bytes'
        })
    }
})

const unregisterSchema = z.object({
    token: z.string().min(1)
})

export function createDevicesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/devices/register', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = registerSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        const { token, platform, deviceId, pushKey } = parsed.data
        if (platform === 'ios') {
            // Store the canonical re-encoding so the send path always
            // decodes cleanly regardless of the client's padding style.
            const decoded = decodePushKey(pushKey ?? '')!
            store.fcm.upsertDevice(namespace, {
                token,
                platform,
                deviceId,
                pushKey: decoded.toString('base64')
            })
        } else {
            store.fcm.upsertDevice(namespace, { token, platform, deviceId })
        }
        return c.json({ ok: true })
    })

    app.delete('/devices/register', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = unregisterSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        store.fcm.removeDeviceByToken(namespace, parsed.data.token)
        return c.json({ ok: true })
    })

    return app
}
