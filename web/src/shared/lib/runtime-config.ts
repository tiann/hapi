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
