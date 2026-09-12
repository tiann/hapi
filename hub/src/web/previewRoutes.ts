import { Hono } from 'hono'

import {
    PREVIEW_MAX_REQUEST_BODY_BYTES,
    PREVIEW_URL_PREFIX,
    stripHopByHopHeaders,
    type PreviewResponseHeaders
} from '@hapi/protocol/preview'

import type { WebAppEnv } from './middleware/auth'
import type { PreviewRegistry } from '../preview/previewRegistry'
import type { PreviewRequestMeta, PreviewTunnel } from '../preview/previewTunnel'

/**
 * Public router for preview capability URLs: `/preview/<mountId>/<path>`.
 * Mounted OUTSIDE the `/api/*` auth middleware on purpose — the unguessable
 * mountId (plus optional `?t=` token) is the credential, so shared links work
 * for LAN/relay visitors without hub accounts.
 */

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

function noStoreText(status: number, message: string): Response {
    return new Response(`${message}\n`, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    })
}

function toResponseHeaders(headers: PreviewResponseHeaders): Headers {
    const out = new Headers()
    for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
            for (const item of value) out.append(name, item)
        } else {
            out.set(name, value)
        }
    }
    return out
}

function buildRequestMeta(method: string, url: URL, mountId: string, rawPath: string, requestHeaders: Record<string, string>, body: Uint8Array | undefined): PreviewRequestMeta {
    const headers = stripHopByHopHeaders(requestHeaders)
    delete headers['host']
    headers['x-forwarded-proto'] = url.protocol.replace(':', '')
    headers['x-forwarded-host'] = url.host
    headers['x-forwarded-prefix'] = `${PREVIEW_URL_PREFIX}/${mountId}`
    headers['via'] = 'hapi-preview'
    if (body !== undefined && body.byteLength > 0) {
        headers['content-length'] = String(body.byteLength)
    }
    return {
        method,
        path: rawPath,
        query: url.search ? url.search.slice(1) : undefined,
        headers,
        body,
        protocols: undefined
    }
}

export function createPreviewRoutes(deps: {
    previewRegistry: PreviewRegistry
    previewTunnel: PreviewTunnel
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const handle = async (c: { req: { method: string; url: string; header: (name: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer> } }): Promise<Response> => {
        const url = new URL(c.req.url)
        const parts = url.pathname.split('/')
        // pathname is `/preview/<mountId>[/<sub...>]`
        const mountId = parts[2] ?? ''
        const rawPath = parts.slice(3).join('/')

        const entry = deps.previewRegistry.get(mountId)
        if (!entry) {
            return deps.previewRegistry.isTombstoned(mountId)
                ? noStoreText(410, 'Preview expired — ask the agent to re-mount it')
                : noStoreText(404, 'Unknown preview')
        }
        if (!deps.previewRegistry.checkToken(entry, url.searchParams.get('t'))) {
            return noStoreText(403, 'Preview token required')
        }

        let body: Uint8Array | undefined
        if (BODY_METHODS.has(c.req.method.toUpperCase())) {
            const declaredLength = Number(c.req.header('content-length') ?? '0')
            if (declaredLength > PREVIEW_MAX_REQUEST_BODY_BYTES) {
                return noStoreText(413, 'Preview request body too large')
            }
            const buffer = await c.req.arrayBuffer()
            if (buffer.byteLength > PREVIEW_MAX_REQUEST_BODY_BYTES) {
                return noStoreText(413, 'Preview request body too large')
            }
            body = new Uint8Array(buffer)
        }

        const requestHeaders: Record<string, string> = {}
        for (const name of ['accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control', 'content-type', 'cookie', 'if-none-match', 'if-modified-since', 'origin', 'pragma', 'range', 'referer', 'user-agent', 'x-forwarded-for', 'x-requested-with']) {
            const value = c.req.header(name)
            if (value !== undefined) requestHeaders[name] = value
        }

        const meta = buildRequestMeta(c.req.method.toUpperCase(), url, mountId, rawPath, requestHeaders, body)
        const conn = deps.previewTunnel.openHttp(entry, meta)
        if (!conn) {
            return noStoreText(503, 'Preview tunnel unavailable')
        }

        const head = await conn.head
        if (!head) {
            return noStoreText(502, 'Preview upstream failed')
        }

        const responseHeaders = toResponseHeaders(head.headers)
        if (head.status === 204 || head.status === 304) {
            return new Response(null, { status: head.status, headers: responseHeaders })
        }
        return new Response(conn.body, { status: head.status, headers: responseHeaders })
    }

    // Paths are RELATIVE to the `/preview` mount point in server.ts. `app.on`
    // is used because Hono has no `.head` convenience method.
    const methods = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as unknown as string[]
    for (const path of ['/:mountId', '/:mountId/*']) {
        app.on(methods, path, (c) => handle(c))
    }

    return app
}
