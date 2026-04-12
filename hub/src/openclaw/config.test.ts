import { afterEach, describe, expect, it } from 'bun:test'
import {
    getMissingOpenClawTransportEnvVars,
    getOpenClawTransportConfig,
    getOpenClawTransportSettings,
    isOpenClawTransportConfigured
} from './config'

describe('openclaw config', () => {
    afterEach(() => {
        delete process.env.OPENCLAW_PLUGIN_BASE_URL
        delete process.env.OPENCLAW_SHARED_SECRET
        delete process.env.OPENCLAW_CHANNEL_TIMEOUT_MS
        delete process.env.OPENCLAW_CHANNEL_ALLOWED_SKEW_MS
    })

    it('reports missing required env vars', () => {
        const settings = getOpenClawTransportSettings()

        expect(isOpenClawTransportConfigured(settings)).toBe(false)
        expect(getMissingOpenClawTransportEnvVars(settings)).toEqual([
            'OPENCLAW_PLUGIN_BASE_URL',
            'OPENCLAW_SHARED_SECRET'
        ])
    })

    it('returns configured transport with timeout defaults', () => {
        process.env.OPENCLAW_PLUGIN_BASE_URL = 'https://plugin.example'
        process.env.OPENCLAW_SHARED_SECRET = 'shared-secret'

        expect(getOpenClawTransportConfig()).toEqual({
            pluginBaseUrl: 'https://plugin.example',
            sharedSecret: 'shared-secret',
            timeoutMs: 30_000,
            allowedTimestampSkewMs: 300_000
        })
    })
})
