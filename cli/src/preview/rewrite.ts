/**
 * Best-effort URL rewriting for proxy mounts served under `/preview/<mountId>/`.
 * Only HTML *attributes* (and Location / Set-Cookie headers) are rewritten —
 * URLs inside inline JS/CSS or runtime `fetch()` calls are not, which is why
 * agents should prefer explicit base configuration (`vite base`, next
 * `basePath`) whenever they control the app.
 */

const HTML_PREFIX_ATTRIBUTE = /\s(src|href|poster|action)=(["'])(\/(?!\/)[^"']*)\2/gi

const SKIP_URL_PREFIXES = /^(data:|mailto:|tel:|javascript:|#)/i

interface SrcsetCandidate {
    url: string
    descriptor: string
}

function splitSrcset(value: string): SrcsetCandidate[] {
    // Srcset separates candidates on commas that are NOT inside the URL part of
    // data: URIs; a pragmatic split handles the common report/preview cases.
    const candidates: SrcsetCandidate[] = []
    for (const part of value.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const [url, ...descriptors] = trimmed.split(/\s+/)
        candidates.push({ url, descriptor: descriptors.join(' ') })
    }
    return candidates
}

/** Rewrites root-relative URLs in a srcset attribute value. */
export function rewriteSrcset(value: string, prefix: string): string {
    return splitSrcset(value)
        .map(({ url, descriptor }) => {
            const rewritten = url.startsWith('/') && !url.startsWith('//') && !SKIP_URL_PREFIXES.test(url)
                ? `${prefix}${url}`
                : url
            return descriptor ? `${rewritten} ${descriptor}` : rewritten
        })
        .join(', ')
}

/** Injects `<base href>` right after `<head>` unless the document has one. */
export function injectBaseTag(html: string, baseHref: string): string {
    if (/<base\s/i.test(html)) return html
    const headMatch = html.match(/<head\b[^>]*>/i)
    if (!headMatch || headMatch.index === undefined) return html
    const insertAt = headMatch.index + headMatch[0].length
    return `${html.slice(0, insertAt)}<base href="${baseHref}">${html.slice(insertAt)}`
}

/** Full HTML rewrite: attribute URLs, srcset, then a <base> injection. */
export function rewriteHtml(html: string, prefix: string): string {
    let output = html.replace(HTML_PREFIX_ATTRIBUTE, (match, attr: string, quote: string, url: string) => {
        if (SKIP_URL_PREFIXES.test(url)) return match
        return ` ${attr}=${quote}${prefix}${url}${quote}`
    })
    output = output.replace(/\ssrcset=(["'])([^"']+)\1/gi, (_match, quote: string, value: string) => {
        return ` srcset=${quote}${rewriteSrcset(value, prefix)}${quote}`
    })
    return injectBaseTag(output, `${prefix}/`)
}

/**
 * Rewrites a `Location` header. Only root-relative targets can be expressed
 * through the mount; absolute upstream origins are left alone (they would leak
 * the dev server's real address, but rewriting them to a fake external URL
 * would be worse).
 */
export function rewriteLocation(value: string, prefix: string): string {
    if (value.startsWith('/')) return `${prefix}${value}`
    return value
}

/** Rewrites a Set-Cookie header's Path attribute to live under the prefix. */
export function rewriteSetCookie(value: string, prefix: string): string {
    const rewritten = value.replace(/;\s*path=\/([^;]*)/i, `; Path=${prefix}/$1`)
    return rewritten
}
