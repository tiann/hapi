/**
 * display_links payload: clickable http(s) URLs constructed outside the model.
 *
 * Stored href bytes must equal the caller-constructed string. Do not canonicalize
 * via `new URL().href` (that can add trailing slashes / lowercase hosts).
 */

export const DISPLAY_LINKS_PAYLOAD_TYPE = 'display-links' as const

export const MAX_DISPLAY_LINKS = 20
export const MAX_DISPLAY_LINK_HREF_LENGTH = 2048
export const MAX_DISPLAY_LINK_TITLE_LENGTH = 255
export const MAX_DISPLAY_TEXT_LENGTH = 8192

const DENY_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file'])

export type DisplayLink = {
    href: string
    title?: string
}

export type DisplayText = {
    value: string
    title?: string
}

export type DisplayLinksPayload = {
    type: typeof DISPLAY_LINKS_PAYLOAD_TYPE
    urls: DisplayLink[]
    texts: DisplayText[]
    id: string
}

/**
 * Extract a scheme the same way markdown-text classifyScheme does: up to two
 * decodeURIComponent passes, then strip ASCII controls/whitespace from the
 * scheme name so `java\nscript:` cannot bypass the deny list.
 */
export function displayLinkScheme(href: string): string | null {
    let value = href.trimStart()
    for (let i = 0; i < 2; i++) {
        try {
            const next = decodeURIComponent(value)
            if (next === value) break
            value = next
        } catch {
            break
        }
    }
    const colonIndex = value.indexOf(':')
    if (colonIndex <= 0) return null
    const boundaryIdx = value.search(/[/?#]/)
    if (boundaryIdx >= 0 && boundaryIdx < colonIndex) return null
    return value.slice(0, colonIndex).replace(/[\x00-\x1F\x7F\s]/g, '').toLowerCase()
}

export function isDisplayableHttpHref(href: string): boolean {
    if (typeof href !== 'string') return false
    if (href.length === 0 || href.length > MAX_DISPLAY_LINK_HREF_LENGTH) return false
    const scheme = displayLinkScheme(href)
    if (scheme === null) return false
    if (DENY_SCHEMES.has(scheme)) return false
    if (scheme !== 'http' && scheme !== 'https') return false
    try {
        const parsed = new URL(href.trim())
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
        return false
    }
}

function normalizeTitle(title: unknown): string | undefined {
    if (typeof title !== 'string') return undefined
    const trimmed = title.trim()
    if (!trimmed) return undefined
    return trimmed.length > MAX_DISPLAY_LINK_TITLE_LENGTH
        ? trimmed.slice(0, MAX_DISPLAY_LINK_TITLE_LENGTH)
        : trimmed
}

export function parseDisplayLink(input: unknown): DisplayLink | null {
    if (typeof input === 'string') {
        const href = input.trim()
        if (!isDisplayableHttpHref(href)) return null
        return { href }
    }
    if (!input || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    const rawHref = record.href ?? record.url
    if (typeof rawHref !== 'string') return null
    const href = rawHref.trim()
    if (!isDisplayableHttpHref(href)) return null
    const title = normalizeTitle(record.title)
    return title ? { href, title } : { href }
}

export function parseDisplayText(input: unknown): DisplayText | null {
    if (typeof input === 'string') {
        if (input.length === 0 || input.length > MAX_DISPLAY_TEXT_LENGTH) return null
        if (input.trim().length === 0) return null
        return { value: input }
    }
    if (!input || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    const rawValue = record.value ?? record.text
    if (typeof rawValue !== 'string') return null
    if (rawValue.length === 0 || rawValue.length > MAX_DISPLAY_TEXT_LENGTH) return null
    if (rawValue.trim().length === 0) return null
    const title = normalizeTitle(record.title)
    return title ? { value: rawValue, title } : { value: rawValue }
}

export function parseDisplayTextsInput(input: unknown): DisplayText[] {
    if (!Array.isArray(input)) {
        throw new Error('display_links requires texts: [{ value, title? }]')
    }
    if (input.length === 0) {
        throw new Error('display_links requires at least one exact-copy string')
    }
    if (input.length > MAX_DISPLAY_LINKS) {
        throw new Error(`display_links accepts at most ${MAX_DISPLAY_LINKS} exact-copy strings`)
    }
    const texts: DisplayText[] = []
    for (const item of input) {
        const parsed = parseDisplayText(item)
        if (!parsed) {
            throw new Error('display_links rejected an exact-copy string (empty or too long)')
        }
        texts.push(parsed)
    }
    return texts
}

export function safeParseDisplayTextsInput(input: unknown): DisplayText[] {
    if (!Array.isArray(input)) return []
    const texts: DisplayText[] = []
    for (const item of input.slice(0, MAX_DISPLAY_LINKS)) {
        const parsed = parseDisplayText(item)
        if (parsed) texts.push(parsed)
    }
    return texts
}

export function parseDisplayLinksToolInput(input: unknown): {
    urls: DisplayLink[]
    texts: DisplayText[]
} {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const hasUrls = Array.isArray(record.urls)
    const hasTexts = Array.isArray(record.texts)
    if (!hasUrls && !hasTexts) {
        throw new Error('display_links requires urls: [{ href, title? }] and/or texts: [{ value, title? }]')
    }
    const urls = hasUrls ? parseDisplayLinksInput(record.urls) : []
    const texts = hasTexts ? parseDisplayTextsInput(record.texts) : []
    if (urls.length === 0 && texts.length === 0) {
        throw new Error('display_links requires urls: [{ href, title? }] and/or texts: [{ value, title? }]')
    }
    return { urls, texts }
}

/**
 * Cursor routes duplicate MCP tool names to one server when many `hapi-*`
 * entries share `display_links`. Require the caller session id so a mis-routed
 * call cannot silently paint another chat.
 */
export function assertBoundDisplayLinksSession(boundSessionId: string, callerSessionId: unknown): void {
    const bound = boundSessionId.trim()
    if (!bound) {
        throw new Error('display_links refused: this MCP server has no bound session id')
    }
    if (typeof callerSessionId !== 'string' || callerSessionId.trim() === '') {
        throw new Error(
            'display_links requires sessionId matching this HAPI session (Cursor may route duplicate MCP tool names to the wrong server)',
        )
    }
    if (callerSessionId.trim() !== bound) {
        throw new Error(
            'display_links refused: sessionId does not match this MCP server (wrong-session routing)',
        )
    }
}

export const DISPLAY_LINKS_REDACTED_VALUE = '[omitted]' as const

/**
 * Per-session MCP tool name so concurrent Cursor `hapi-*` overlays do not
 * collide on bare `display_links` (forum 148059). Redaction matchers already
 * accept names ending in `_display_links`.
 */
export function buildDisplayLinksToolName(sessionId: string): string {
    const id = sessionId.trim().replaceAll('-', '_')
    if (!id) {
        throw new Error('display_links tool name requires a non-empty session id')
    }
    return `hapi_${id}_display_links`
}

export function isDisplayLinksToolName(name: unknown): boolean {
    if (typeof name !== 'string') return false
    const normalized = name.trim().toLowerCase().replace(/[\s-]+/g, '_')
    return normalized === 'display_links'
        || normalized.endsWith('_display_links')
        || normalized.endsWith('/display_links')
}

/** Strip exact-copy bytes from a tool-call input record (hub/export must not store secrets). */
export function redactDisplayLinksToolInput(input: unknown): unknown {
    if (input == null) return input
    if (typeof input !== 'object' || Array.isArray(input)) {
        return DISPLAY_LINKS_REDACTED_VALUE
    }
    const record = input as Record<string, unknown>
    const safe: Record<string, unknown> = {}
    if (Object.prototype.hasOwnProperty.call(record, 'urls')) {
        safe.urls = safeParseDisplayLinksInput(record.urls)
    }
    if (Object.prototype.hasOwnProperty.call(record, 'texts')) {
        safe.texts = Array.isArray(record.texts)
            ? record.texts.map((item) => {
                if (typeof item === 'string') return DISPLAY_LINKS_REDACTED_VALUE
                const row = item && typeof item === 'object' && !Array.isArray(item)
                    ? item as Record<string, unknown>
                    : null
                const title = typeof row?.title === 'string' ? row.title : undefined
                return title === undefined
                    ? { value: DISPLAY_LINKS_REDACTED_VALUE }
                    : { value: DISPLAY_LINKS_REDACTED_VALUE, title }
            })
            : DISPLAY_LINKS_REDACTED_VALUE
    }
    if (typeof record.sessionId === 'string') {
        safe.sessionId = record.sessionId
    }
    return safe
}

export function parseDisplayLinksInput(input: unknown): DisplayLink[] {
    if (!Array.isArray(input)) {
        throw new Error('display_links requires urls: [{ href, title? }]')
    }
    if (input.length === 0) {
        throw new Error('display_links requires at least one URL')
    }
    if (input.length > MAX_DISPLAY_LINKS) {
        throw new Error(`display_links accepts at most ${MAX_DISPLAY_LINKS} URLs`)
    }
    const urls: DisplayLink[] = []
    for (const item of input) {
        const parsed = parseDisplayLink(item)
        if (!parsed) {
            throw new Error('display_links rejected a URL (http/https only; javascript/data/vbscript/file denied)')
        }
        urls.push(parsed)
    }
    return urls
}

export function safeParseDisplayLinksInput(input: unknown): DisplayLink[] {
    if (!Array.isArray(input)) return []
    const urls: DisplayLink[] = []
    for (const item of input.slice(0, MAX_DISPLAY_LINKS)) {
        const parsed = parseDisplayLink(item)
        if (parsed) urls.push(parsed)
    }
    return urls
}

export function buildDisplayLinksPayload(args: {
    urls: DisplayLink[]
    texts?: DisplayText[]
    id: string
}): DisplayLinksPayload {
    return {
        type: DISPLAY_LINKS_PAYLOAD_TYPE,
        urls: args.urls,
        texts: args.texts ?? [],
        id: args.id,
    }
}
