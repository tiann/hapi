const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000

function readNotBefore(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null
    }
    const value = payload.notBefore
    return Number.isInteger(value) && value > 0 ? value : null
}

export function activate(ctx) {
    ctx.messages.registerAction({
        id: 'schedule-send',
        kind: 'chat.composer.messageAction',
        async plan(input) {
            const notBefore = readNotBefore(input.payload)
            if (notBefore === null) {
                return { ok: false, code: 'invalid-not-before', message: 'Schedule send requires payload.notBefore as a positive integer timestamp.' }
            }
            if (!input.localId) {
                return { ok: false, code: 'missing-local-id', message: 'Scheduled messages require localId.' }
            }
            if (input.attachments.length > 0) {
                return { ok: false, code: 'attachments-unsupported', message: 'Scheduled messages with attachments are not supported.' }
            }
            if (notBefore > Date.now() + MAX_DELAY_MS) {
                return { ok: false, code: 'schedule-too-far', message: 'Schedule time must be within 7 days.' }
            }
            return {
                ok: true,
                plan: {
                    type: 'messageDelivery',
                    delivery: { notBefore },
                    source: {
                        pluginId: ctx.pluginId,
                        capabilityId: 'schedule-send',
                        actionId: 'schedule-send'
                    },
                    payload: input.payload
                }
            }
        }
    })
}
