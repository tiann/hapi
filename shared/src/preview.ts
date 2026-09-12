import { z } from 'zod'

/**
 * Preview protocol shared by the CLI (mount owner + local terminator) and the
 * hub (public router on its own HTTP port). One multiplexed "preview tunnel"
 * rides the existing CLI->hub socket.io `/cli` connection: the hub opens a
 * virtual conn per browser request / WebSocket upgrade and exchanges small
 * frames with the CLI, which terminates them against the local filesystem
 * (static mounts) or a loopback dev server (proxy mounts).
 *
 * URLs are capability tokens: `${HAPI_PUBLIC_URL}/preview/<mountId>/<path>`.
 * The `/preview/*` route group deliberately sits outside the hub auth
 * middleware — the unguessable mountId (plus optional per-mount token) is the
 * credential, so shared links work for LAN/relay visitors without hub accounts.
 */

// --- Limits (single source of truth for both processes) ---

export const PREVIEW_URL_PREFIX = '/preview'
export const PREVIEW_MAX_MOUNTS_PER_SESSION = 8
export const PREVIEW_HUB_TOTAL_MOUNTS = 512
export const PREVIEW_HUB_TOTAL_CONNS = 256
export const PREVIEW_CONNS_PER_MOUNT = 32
/** Aligns with MAX_GENERATED_IMAGE_BYTES. */
export const PREVIEW_MAX_FILE_BYTES = 25 * 1024 * 1024
export const PREVIEW_MAX_REQUEST_BODY_BYTES = 1024 * 1024
export const PREVIEW_MAX_RESPONSE_BUFFER_BYTES = 8 * 1024 * 1024
export const PREVIEW_RESUME_BUFFER_BYTES = 2 * 1024 * 1024
export const PREVIEW_FRAME_PAYLOAD_BYTES = 256 * 1024
export const PREVIEW_MAX_RESPONSE_HEADERS = 100
export const PREVIEW_DEFAULT_TTL_SECONDS = 12 * 3600
export const PREVIEW_MAX_TTL_SECONDS = 7 * 24 * 3600
export const PREVIEW_OPEN_TIMEOUT_MS = 30_000
export const PREVIEW_IDLE_TIMEOUT_MS = 120_000
export const PREVIEW_REGISTER_ACK_TIMEOUT_MS = 10_000
export const PREVIEW_TOMBSTONE_TTL_MS = 5 * 60_000

// --- Socket event names (namespace `/cli`) ---

export const PREVIEW_EVENTS = {
    register: 'preview:register',
    unregister: 'preview:unregister',
    frame: 'preview:frame',
} as const

// --- Frames ---

/**
 * Binary payloads cross the socket as Buffer (node) / Uint8Array (browser)
 * which TS 5.7 models as `Uint8Array<ArrayBufferLike>`; the schema below is
 * cast so both sides agree on that wider view type.
 */
export type PreviewBytes = Uint8Array<ArrayBufferLike>

export const PreviewBytesSchema = z.instanceof(Uint8Array) as unknown as z.ZodType<PreviewBytes>

/** Lowercase header names, already sanitized by the emitting side. */
export const PreviewRequestHeadersSchema = z.record(z.string().min(1), z.string())
export type PreviewRequestHeaders = z.infer<typeof PreviewRequestHeadersSchema>

/**
 * Response headers additionally allow string arrays — but only for `set-cookie`,
 * where joining with "," would corrupt Expires dates.
 */
export const PreviewResponseHeadersSchema = z.record(
    z.string().min(1),
    z.union([z.string(), z.array(z.string())])
)
export type PreviewResponseHeaders = z.infer<typeof PreviewResponseHeadersSchema>

const previewConnIdSchema = z.string().min(1).max(64)
const previewBodySchema = PreviewBytesSchema.refine((bytes) => bytes.byteLength <= PREVIEW_MAX_REQUEST_BODY_BYTES)

export const PreviewOpenFrameSchema = z.object({
    type: z.literal('open'),
    connId: previewConnIdSchema,
    mountId: z.string().uuid(),
    kind: z.enum(['http', 'ws']),
    method: z.string().min(1).max(16).optional(),
    /** Raw (still percent-encoded) sub-path below `/preview/<mountId>/`, never starts with `/`. */
    path: z.string().max(2048),
    /** Raw query string without the leading `?`. */
    query: z.string().max(4096).optional(),
    headers: PreviewRequestHeadersSchema,
    body: previewBodySchema.optional(),
    /** `sec-websocket-protocol` request header, when the browser sent one. */
    protocols: z.string().max(1024).optional(),
})

export const PreviewResponseFrameSchema = z.object({
    type: z.literal('response'),
    connId: previewConnIdSchema,
    status: z.number().int().min(100).max(599),
    headers: PreviewResponseHeadersSchema,
})

export const PreviewDataFrameSchema = z.object({
    type: z.literal('data'),
    connId: previewConnIdSchema,
    seq: z.number().int().nonnegative(),
    payload: PreviewBytesSchema,
})

export const PreviewEndFrameSchema = z.object({
    type: z.literal('end'),
    connId: previewConnIdSchema,
})

export const PreviewErrorFrameSchema = z.object({
    type: z.literal('error'),
    connId: previewConnIdSchema,
    status: z.number().int().min(400).max(599).optional(),
    message: z.string().max(512),
})

export const PreviewCloseFrameSchema = z.object({
    type: z.literal('close'),
    connId: previewConnIdSchema,
})

export const PreviewWsMessageFrameSchema = z.object({
    type: z.literal('ws-message'),
    connId: previewConnIdSchema,
    isText: z.boolean(),
    payload: z.union([z.string(), PreviewBytesSchema]),
})

export const PreviewWsCloseFrameSchema = z.object({
    type: z.literal('ws-close'),
    connId: previewConnIdSchema,
    code: z.number().int().min(0).max(9999),
    reason: z.string().max(256).optional(),
})

export const PreviewPauseFrameSchema = z.object({
    type: z.literal('pause'),
    connId: previewConnIdSchema,
})

export const PreviewResumeFrameSchema = z.object({
    type: z.literal('resume'),
    connId: previewConnIdSchema,
})

export const PreviewFrameSchema = z.discriminatedUnion('type', [
    PreviewOpenFrameSchema,
    PreviewResponseFrameSchema,
    PreviewDataFrameSchema,
    PreviewEndFrameSchema,
    PreviewErrorFrameSchema,
    PreviewCloseFrameSchema,
    PreviewWsMessageFrameSchema,
    PreviewWsCloseFrameSchema,
    PreviewPauseFrameSchema,
    PreviewResumeFrameSchema,
])

export type PreviewFrame = z.infer<typeof PreviewFrameSchema>
export type PreviewOpenFrame = z.infer<typeof PreviewOpenFrameSchema>
export type PreviewResponseFrame = z.infer<typeof PreviewResponseFrameSchema>
export type PreviewDataFrame = z.infer<typeof PreviewDataFrameSchema>

// --- Mount registration ---

export const PreviewMountDescriptorSchema = z
    .object({
        mountId: z.string().uuid(),
        kind: z.enum(['static', 'proxy']),
        /** Human-facing label; also the `preview_stop`/re-register handle. */
        name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
        rootPath: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        url: z.string().url().optional(),
        /** Proxy mounts only: pass WebSocket upgrades through (HMR). */
        ws: z.boolean().optional(),
        /** Extra capability token checked against `?t=` on every request. */
        token: z.string().min(8).max(128).optional(),
        ttlSeconds: z.number().int().min(30).max(PREVIEW_MAX_TTL_SECONDS).optional(),
    })
    .refine((mount) => mount.kind !== 'static' || (mount.rootPath !== undefined && mount.port === undefined && mount.url === undefined), {
        message: 'static mounts require rootPath and must not set port/url',
    })
    .refine((mount) => mount.kind !== 'proxy' || ((mount.port !== undefined) !== (mount.url !== undefined) && mount.rootPath === undefined), {
        message: 'proxy mounts require exactly one of port/url and no rootPath',
    })

export type PreviewMountDescriptor = z.infer<typeof PreviewMountDescriptorSchema>

export const PreviewRegisterAckSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        url: z.string().url(),
        mountId: z.string().uuid(),
        expiresAt: z.number(),
    }),
    z.object({
        ok: z.literal(false),
        error: z.string().max(256),
        code: z.enum(['cap', 'invalid', 'unknown']),
    }),
])

export type PreviewRegisterAck = z.infer<typeof PreviewRegisterAckSchema>

export const PreviewUnregisterRequestSchema = z
    .object({
        mountId: z.string().uuid().optional(),
        name: z.string().max(64).optional(),
        all: z.boolean().optional(),
    })
    .refine((req) => (req.mountId !== undefined) !== (req.name !== undefined) || (req.all === true && req.mountId === undefined && req.name === undefined), {
        message: 'specify exactly one of mountId/name/all',
    })

export type PreviewUnregisterRequest = z.infer<typeof PreviewUnregisterRequestSchema>

// --- MCP tool arg schemas (single source for the HTTP MCP server and the
// stdio bridge, which must not re-declare them) ---

export const PreviewStaticToolArgsSchema = z.object({
    path: z.string().describe('Absolute directory to expose read-only over HTTP.'),
    name: z.string().max(64).optional().describe('Short label for later unmounting; defaults to the directory basename.'),
    ttlHours: z.number().min(0.1).max(168).optional().describe('Hours until the URL expires (default 12, max 168).'),
})

export const PreviewProxyToolArgsSchema = z.object({
    port: z.number().int().min(1).max(65535).optional().describe('Loopback port of the local dev server to proxy.'),
    url: z.string().url().optional().describe('Loopback http(s) URL alternative to `port` (e.g. http://localhost:5173).'),
    name: z.string().max(64).optional().describe('Short label for later unmounting; defaults to `port-<port>`.'),
    ttlHours: z.number().min(0.1).max(168).optional().describe('Hours until the URL expires (default 12, max 168).'),
    ws: z.boolean().optional().describe('Pass WebSocket upgrades through (HMR). Default true.'),
})

export const PreviewStopToolArgsSchema = z.object({
    name: z.string().max(64).optional().describe('Unmount the mount registered under this name.'),
    mountId: z.string().uuid().optional().describe('Unmount this exact mount.'),
    all: z.boolean().optional().describe('Unmount every mount of this session.'),
})

/** Shared by tool results so every flavor explains the sub-path caveat. */
export const PREVIEW_SUBPATH_NOTE =
    'Notes: served under a sub-path; absolute paths starting with "/" inside HTML attributes are rewritten, ' +
    'but URLs inside inline JS/CSS are NOT. Prefer relative paths, or set an explicit base ' +
    '(vite `base`, next `basePath`) for full fidelity.'

export const PREVIEW_STATIC_TOOL_DESCRIPTION =
    'Mount a local directory as a read-only static web preview on the HAPI hub and get a clickable URL. ' +
    "Call it right after you create HTML pages, reports, charts or demos the user should open in a browser; pass the absolute directory that contains index.html (or the entry files). " +
    'The URL is a capability link: anyone who has it can read the mounted files until it expires or preview_stop removes it, so mounting requires user approval. ' +
    'Files are served as-is (no directory listing, 25 MiB per file, dotfiles rejected); for apps that assume they run at "/" prefer build-time base configuration over absolute paths.'

export const PREVIEW_PROXY_TOOL_DESCRIPTION =
    'Reverse-proxy a local dev server (vite/next/django, ...) onto the HAPI hub so its UI can be opened in a browser through the hub port. ' +
    'Call it after starting the server on 127.0.0.1 (loopback only — never bind or proxy non-loopback hosts); pass the port, or url for a full loopback URL. ' +
    'WebSocket pass-through (HMR) is on by default. Like preview_static, the returned URL is a capability link readable by anyone who obtains it until it expires or preview_stop removes it, so mounting requires user approval.'

export const PREVIEW_STOP_TOOL_DESCRIPTION =
    'Unmount one or all previews previously created with preview_static/preview_proxy in this session; mounted URLs immediately stop working (410 after a short grace period). ' +
    'Call it when the user is done viewing a preview, before mounting a new version of the same site, or with all=true when wrapping up.'

// --- Pure helpers ---

/** Builds `${publicUrl}/preview/<mountId>/<sub>` with normalized slashes. */
export function buildPreviewUrl(publicUrl: string, mountId: string, sub = ''): string {
    const base = publicUrl.replace(/\/+$/, '')
    const tail = sub.replace(/^\/+/, '').replace(/\?.*$/, '')
    return `${base}${PREVIEW_URL_PREFIX}/${mountId}/${tail ? `${tail}/` : ''}`
}

/**
 * Splits a raw (still percent-encoded) pathname like `/preview/<mountId>/<sub>`
 * into its mount id and raw sub-path. Returns null for anything else.
 */
export function parsePreviewPath(pathname: string): { mountId: string; sub: string } | null {
    if (!pathname.startsWith(`${PREVIEW_URL_PREFIX}/`)) return null
    const rest = pathname.slice(PREVIEW_URL_PREFIX.length + 1)
    const slash = rest.indexOf('/')
    const mountId = slash === -1 ? rest : rest.slice(0, slash)
    if (!/^[0-9a-fA-F-]{36}$/.test(mountId)) return null
    return { mountId, sub: slash === -1 ? '' : rest.slice(slash + 1) }
}

/**
 * Proxy targets must be loopback: the CLI terminates tunnel conns on the agent
 * machine, and exposing non-loopback hosts via a public preview URL would turn
 * the agent into an SSRF pivot.
 */
export function isLoopbackTarget(url: URL): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

const HOP_BY_HOP_SET = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
])

export const HOP_BY_HOP_HEADERS = [...HOP_BY_HOP_SET]

/** Drops hop-by-hop headers plus anything named in a `Connection` header. */
export function stripHopByHopHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {}
    const connectionHeader = Object.entries(headers).find(([name]) => name.toLowerCase() === 'connection')?.[1] ?? ''
    const connectionList = connectionHeader
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase()
        if (HOP_BY_HOP_SET.has(lower) || connectionList.includes(lower)) continue
        result[lower] = value
    }
    return result
}
