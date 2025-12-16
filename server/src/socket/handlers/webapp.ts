import type { Socket } from 'socket.io'
import { z } from 'zod'

const subscribeSchema = z.object({
    all: z.boolean().optional(),
    sessionId: z.string().optional(),
    machineId: z.string().optional()
})

export type WebappHandlersDeps = {
    onSubscribe?: (socket: Socket, data: { sessionId?: string; machineId?: string }) => void
}

export function registerWebappHandlers(socket: Socket, deps: WebappHandlersDeps): void {
    type SubscriptionState = {
        all: boolean
        sessionId: string | null
        machineId: string | null
    }

    let state: SubscriptionState = {
        all: false,
        sessionId: null,
        machineId: null
    }

    socket.on('subscribe', (data: unknown) => {
        const parsed = subscribeSchema.safeParse(data ?? {})
        if (!parsed.success) {
            return
        }

        const { all, sessionId, machineId } = parsed.data

        const next: SubscriptionState = {
            all: Boolean(all),
            sessionId: sessionId ?? null,
            machineId: machineId ?? null
        }

        if (state.all && !next.all) {
            socket.leave('webapp:all')
        }
        if (!state.all && next.all) {
            socket.join('webapp:all')
        }

        if (state.sessionId && state.sessionId !== next.sessionId) {
            socket.leave(`session:${state.sessionId}`)
        }

        if (next.sessionId && next.sessionId !== state.sessionId) {
            socket.join(`session:${next.sessionId}`)
        }

        if (state.machineId && state.machineId !== next.machineId) {
            socket.leave(`machine:${state.machineId}`)
        }

        if (next.machineId && next.machineId !== state.machineId) {
            socket.join(`machine:${next.machineId}`)
        }

        state = next

        deps.onSubscribe?.(socket, { sessionId: next.sessionId ?? undefined, machineId: next.machineId ?? undefined })
    })
}
