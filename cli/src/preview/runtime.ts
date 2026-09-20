import { PreviewFrameSchema, type PreviewFrame, type PreviewOpenFrame } from '@hapi/protocol/preview'

import { logger } from '@/ui/logger'

import { PreviewMountManager, type MountProxyArgs, type MountStaticArgs, type PreviewMount, type PreviewSocketAdapter, type StopArgs } from './mountManager'
import { serveProxyMount } from './proxyClient'
import { serveStaticMount } from './staticServer'
import { PreviewTunnel, type PreviewTerminator } from './tunnelClient'

/**
 * Per-session preview runtime: owns the mount table, the tunnel multiplexer,
 * and the per-mount terminator closures. Created lazily by ApiSessionClient —
 * a session that never mounts anything pays nothing.
 */
export class PreviewRuntime {
    readonly mounts: PreviewMountManager
    private readonly tunnel: PreviewTunnel

    constructor(socket: PreviewSocketAdapter) {
        this.tunnel = new PreviewTunnel(socket)
        this.mounts = new PreviewMountManager(socket)
    }

    handleFrame(raw: unknown): void {
        const parsed = PreviewFrameSchema.safeParse(raw)
        if (!parsed.success) {
            logger.debug('[preview] Dropping malformed frame')
            return
        }
        const frame: PreviewFrame = parsed.data
        if (frame.type !== 'open') {
            this.tunnel.handleFrame(frame)
            return
        }
        const mount = this.mounts.getByMountId(frame.mountId)
        if (!mount) {
            // Unknown/expired mount: close the conn so the hub fails fast.
            this.tunnel.rejectOpen(frame.connId)
            return
        }
        this.tunnel.acceptOpen(frame, this.terminatorFor(mount))
    }

    onConnect(): void {
        void this.mounts.reregisterAll().catch((error) => {
            logger.debug('[preview] Re-register sweep failed:', error instanceof Error ? error.message : String(error))
        })
    }

    onDisconnect(): void {
        this.tunnel.failAll('preview socket disconnected')
        this.mounts.onDisconnect()
    }

    private terminatorFor(mount: PreviewMount): PreviewTerminator {
        return (frame: PreviewOpenFrame, sink) => {
            // `acceptOpen` only ever passes the open frame of this mount.
            if (mount.kind === 'static') return serveStaticMount(mount, frame, sink)
            return serveProxyMount(mount, frame, sink)
        }
    }
}

export function createPreviewRuntime(socket: PreviewSocketAdapter): PreviewRuntime {
    return new PreviewRuntime(socket)
}

export type { MountProxyArgs, MountStaticArgs, PreviewMount, StopArgs }
