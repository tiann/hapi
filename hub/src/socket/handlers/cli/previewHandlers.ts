import {
    PREVIEW_EVENTS,
    PreviewMountDescriptorSchema,
    PreviewUnregisterRequestSchema,
    type PreviewRegisterAck
} from '@hapi/protocol/preview'

import type { CliSocketWithData } from '../../socketTypes'
import type { PreviewRegistry } from '../../../preview/previewRegistry'
import type { PreviewTunnel } from '../../../preview/previewTunnel'

/**
 * Preview mount registry + tunnel frames on the `/cli` namespace. The CLI is
 * authenticated by the namespace middleware; mount descriptors are validated
 * with the shared zod schema before they may create a public capability URL.
 */

export type PreviewHandlersDeps = {
    previewRegistry: PreviewRegistry
    previewTunnel: PreviewTunnel
    namespace: string | null
    sessionId: string | null
}

export function attachPreviewSocketHandlers(socket: CliSocketWithData, deps: PreviewHandlersDeps): void {
    const { previewRegistry, previewTunnel, namespace, sessionId } = deps

    socket.on(PREVIEW_EVENTS.register, (data: unknown, callback?: (ack: PreviewRegisterAck) => void) => {
        const parsed = PreviewMountDescriptorSchema.safeParse(data)
        if (!parsed.success) {
            callback?.({ ok: false, error: 'invalid mount descriptor', code: 'invalid' })
            return
        }
        callback?.(previewRegistry.register(parsed.data, { socketId: socket.id, namespace, sessionId }))
    })

    socket.on(PREVIEW_EVENTS.unregister, (data: unknown, callback?: (ack: { ok: boolean }) => void) => {
        const parsed = PreviewUnregisterRequestSchema.safeParse(data)
        if (!parsed.success) {
            callback?.({ ok: false })
            return
        }
        previewRegistry.unregister(parsed.data, { socketId: socket.id, namespace, sessionId })
        callback?.({ ok: true })
    })

    socket.on(PREVIEW_EVENTS.frame, (data: unknown) => {
        previewTunnel.handleFrame(socket.id, data)
    })
}

/** CLI socket gone: drop its mounts and fail its tunnel conns. */
export function cleanupPreviewHandlers(socket: CliSocketWithData, deps: PreviewHandlersDeps): void {
    deps.previewRegistry.evictSocket(socket.id)
    deps.previewTunnel.detachSocket(socket.id)
}
