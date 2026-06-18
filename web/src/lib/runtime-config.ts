const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function parseBooleanFlag(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    return TRUE_VALUES.has(value.trim().toLowerCase())
}

export function requireHubUrlForLogin(): boolean {
    return parseBooleanFlag(import.meta.env.VITE_REQUIRE_HUB_URL)
}

export function normalizeBaseUrl(value: string | undefined): string {
    if (!value || value === '/') {
        return '/'
    }
    const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
    return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`
}

export function getPreviewBasepath(baseUrl: string = import.meta.env.BASE_URL): string | undefined {
    const normalized = normalizeBaseUrl(baseUrl)
    return normalized === '/new/' ? '/new' : undefined
}

export function isPreviewUiMode(baseUrl: string = import.meta.env.BASE_URL): boolean {
    return getPreviewBasepath(baseUrl) !== undefined
}
