// ── Markdown URI scheme policy ──────────────────────────────────────────────
//
// Keep URL classification independent from the React Markdown components so
// file-asset resolution can reuse the same security policy without creating a
// component-to-library import cycle.

const IANA_SAFE_SCHEMES: ReadonlySet<string> = new Set([
    'http',
    'https',
    'irc',
    'ircs',
    'mailto',
    'xmpp',
])

const DENY_SCHEMES: ReadonlySet<string> = new Set([
    'javascript',
    'data',
    'vbscript',
    'file',
])

/** Extract and normalize a URL scheme after decoding common bypass forms. */
export function normalizedScheme(url: string): string | null {
    let value = url.trimStart()
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
    return value.slice(0, colonIndex).replace(/[\x00-\x1F\x7F\s]/g, '').toLowerCase()
}

export function classifyScheme(url: string): 'iana' | 'deny' | 'custom' {
    const scheme = normalizedScheme(url)
    if (scheme === null) return 'deny'
    if (DENY_SCHEMES.has(scheme)) return 'deny'
    if (IANA_SAFE_SCHEMES.has(scheme)) return 'iana'
    return 'custom'
}

export function isDeniedScheme(scheme: string): boolean {
    return DENY_SCHEMES.has(scheme.toLowerCase())
}

/** Return true when href contains a scheme before any path/query delimiter. */
export function hasScheme(href: string): boolean {
    const colonIdx = href.indexOf(':')
    if (colonIdx <= 0) return false
    const boundaryIdx = href.search(/[/?#]/)
    return boundaryIdx < 0 || colonIdx < boundaryIdx
}

export function isExternalHttpHref(href: string | null | undefined): boolean {
    if (!href || !hasScheme(href)) return false
    const colonIdx = href.indexOf(':')
    const scheme = href.slice(0, colonIdx).toLowerCase()
    return scheme === 'http' || scheme === 'https'
}

/** Strip only deny-listed schemes; preserve relative and custom URLs. */
export function denyOnlyTransform(url: string): string {
    if (!url) return url
    const trimmed = url.trimStart()
    const colonIdx = trimmed.indexOf(':')
    const slashIdx = trimmed.search(/[/?#]/)
    if (colonIdx < 0 || (slashIdx >= 0 && slashIdx < colonIdx)) {
        return url
    }
    return classifyScheme(url) === 'deny' ? '' : url
}
