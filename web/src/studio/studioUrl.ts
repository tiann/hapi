export function resolveStudioApiOrigin(hub: string | null, pageOrigin: string): string {
    const fallback = new URL(pageOrigin).origin
    if (!hub) return fallback
    try {
        const candidate = new URL(hub, fallback)
        if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return fallback
        return candidate.origin
    } catch {
        return fallback
    }
}

export function buildStudioShareUrl(pageOrigin: string, token: string, hubBaseUrl: string, basePath = '/'): string {
    const base = new URL(basePath || '/', pageOrigin)
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    const page = new URL(`studio/${encodeURIComponent(token)}`, base)
    const hubOrigin = resolveStudioApiOrigin(hubBaseUrl, page.origin)
    if (hubOrigin !== page.origin) page.searchParams.set('hub', hubOrigin)
    return page.toString()
}
