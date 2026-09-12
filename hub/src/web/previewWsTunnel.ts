import { PREVIEW_URL_PREFIX } from '@hapi/protocol/preview'

import type { PreviewRegistry } from '../preview/previewRegistry'
import type { PreviewRequestMeta, PreviewTunnel, PreviewWsConn } from '../preview/previewTunnel'

/**
 * WebSocket pass-through for preview mounts (dev-server HMR). The Bun upgrade
 * happens in `fetch` (see server.ts); this module bridges the upgraded
 * ServerWebSocket and the CLI tunnel conn. Shaped like qwenProxyHandler so it
 * slots into the existing websocket dispatch.
 */

export interface PreviewWsData {
    _previewTunnelConn?: PreviewWsConn
}

export function isPreviewWsUpgrade(pathname: string, req: Request): boolean {
    return pathname.startsWith(`${PREVIEW_URL_PREFIX}/`) && (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
}

/**
 * Resolves the mount, applies the token check, and builds the upgrade data.
 * Returns null when the request must be rejected (caller picks the status).
 */
export function resolvePreviewUpgrade(
    pathname: string,
    url: URL,
    req: Request,
    registry: PreviewRegistry
): { entry: NonNullable<ReturnType<PreviewRegistry['get']>>; meta: PreviewRequestMeta } | null {
    const mountId = pathname.split('/')[2] ?? ''
    const entry = registry.get(mountId)
    if (!entry) return null
    if (!entry.ws) return null
    if (!registry.checkToken(entry, url.searchParams.get('t'))) return null
    const rawPath = pathname.split('/').slice(3).join('/')
    const meta: PreviewRequestMeta = {
        method: 'GET',
        path: rawPath,
        query: url.search ? url.search.slice(1) : undefined,
        headers: {
            // Dev servers (vite) validate Origin/Host on HMR sockets.
            host: url.host,
            origin: url.origin,
            'x-forwarded-proto': url.protocol.replace(':', ''),
            'x-forwarded-host': url.host,
            'x-forwarded-prefix': `${PREVIEW_URL_PREFIX}/${mountId}`,
            via: 'hapi-preview'
        },
        body: undefined,
        protocols: req.headers.get('sec-websocket-protocol') ?? undefined
    }
    return { entry, meta }
}

export function createPreviewWsTunnelHandler() {
    type WsLike = {
        data: PreviewWsData
        send: (data: string | Uint8Array, compress?: boolean) => number
        close: (code?: number, reason?: string) => void
    }
    return {
        open(ws: WsLike): void {
            const conn = ws.data._previewTunnelConn
            if (!conn) {
                ws.close(1011, 'preview tunnel missing')
                return
            }
            conn.onMessage((payload, isText) => {
                // Bun infers text vs binary from the value type: string → text.
                void isText
                ws.send(payload)
            })
            conn.onClose((code, reason) => {
                ws.close(normalizeCloseCode(code), reason)
            })
        },
        message(ws: WsLike, message: unknown): void {
            const conn = ws.data._previewTunnelConn
            if (!conn) return
            if (typeof message === 'string') {
                conn.send(message, true)
                return
            }
            if (message instanceof Uint8Array) {
                conn.send(new Uint8Array(message.buffer, message.byteOffset, message.byteLength), false)
                return
            }
            if (message instanceof ArrayBuffer) {
                conn.send(new Uint8Array(message), false)
            }
        },
        close(ws: WsLike, code: number, reason: string): void {
            const conn = ws.data._previewTunnelConn
            if (!conn) return
            conn.close(normalizeCloseCode(code), reason || undefined)
        }
    }
}

/** Bun uses 1005/1006 internally; only real protocol codes may be sent. */
function normalizeCloseCode(code: number): number {
    if (code === 1005 || code === 1006 || code === 1015 || code === 0) return 1000
    return code
}
