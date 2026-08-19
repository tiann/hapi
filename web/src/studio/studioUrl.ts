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

export function buildStudioShareUrl(pageOrigin: string, token: string, hubBaseUrl: string): string {
    const page = new URL(`/studio/${encodeURIComponent(token)}`, pageOrigin)
    const hubOrigin = resolveStudioApiOrigin(hubBaseUrl, page.origin)
    if (hubOrigin !== page.origin) page.searchParams.set('hub', hubOrigin)
    return page.toString()
}
