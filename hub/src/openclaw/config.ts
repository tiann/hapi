export type OpenClawTransportSettings = {
    pluginBaseUrl: string | null
    sharedSecret: string | null
    timeoutMs: number
    allowedTimestampSkewMs: number
}

export type OpenClawTransportConfig = {
    pluginBaseUrl: string
    sharedSecret: string
    timeoutMs: number
    allowedTimestampSkewMs: number
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) {
        return fallback
    }
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback
    }
    return parsed
}

export function getOpenClawTransportSettings(): OpenClawTransportSettings {
    return {
        pluginBaseUrl: process.env.OPENCLAW_PLUGIN_BASE_URL?.trim() || null,
        sharedSecret: process.env.OPENCLAW_SHARED_SECRET?.trim() || null,
        timeoutMs: parsePositiveInt(process.env.OPENCLAW_CHANNEL_TIMEOUT_MS, 30_000),
        allowedTimestampSkewMs: parsePositiveInt(process.env.OPENCLAW_CHANNEL_ALLOWED_SKEW_MS, 300_000)
    }
}

export function isOpenClawTransportConfigured(
    settings: OpenClawTransportSettings
): settings is OpenClawTransportConfig {
    return Boolean(settings.pluginBaseUrl && settings.sharedSecret)
}

export function getMissingOpenClawTransportEnvVars(settings: OpenClawTransportSettings): string[] {
    const missing: string[] = []
    if (!settings.pluginBaseUrl) {
        missing.push('OPENCLAW_PLUGIN_BASE_URL')
    }
    if (!settings.sharedSecret) {
        missing.push('OPENCLAW_SHARED_SECRET')
    }
    return missing
}

export function getOpenClawTransportConfig(): OpenClawTransportConfig {
    const settings = getOpenClawTransportSettings()
    if (!isOpenClawTransportConfigured(settings)) {
        throw new Error('OpenClaw transport is missing OPENCLAW_PLUGIN_BASE_URL or OPENCLAW_SHARED_SECRET')
    }
    return settings
}
