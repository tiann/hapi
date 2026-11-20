import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fetchThroughAuthProxy } from '@/api/authProxy'
import { extractTelemetryCapability, probeCapability } from './negotiate'
import { captureEvent, queuedEventsForTest } from './queue'
import { state } from './state'
import {
    forceEnableTelemetryForTest,
    installForTest,
    resetTelemetryForTest,
    stubTelemetryFetch,
    type TelemetryFetchKit,
} from './testHelpers'
import { installTelemetry } from './index'

/**
 * Capability & level negotiation: old-hub disable + 30min re-probe, level
 * gating by TELEMETRY_KINDS minLevel, token harvesting from the authProxy
 * single fetch point.
 */

let kit: TelemetryFetchKit

beforeEach(() => {
    vi.useFakeTimers()
    kit = stubTelemetryFetch({ level: 1 })
})

afterEach(() => {
    kit.restore()
    resetTelemetryForTest()
    vi.useRealTimers()
})

async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
}

describe('extractTelemetryCapability', () => {
    it('reads the agreed hub shape { telemetry: true, telemetryLevel: n }', () => {
        expect(extractTelemetryCapability({ telemetry: true, telemetryLevel: 2 })).toEqual({ level: 2 })
        expect(extractTelemetryCapability({ telemetry: true })).toEqual({ level: 1 })
        expect(extractTelemetryCapability({ telemetry: true, telemetryLevel: 0 })).toEqual({ level: 0 })
    })

    it('accepts the { telemetry: { enabled, level } } variant', () => {
        expect(extractTelemetryCapability({ telemetry: { enabled: true, level: 3 } })).toEqual({ level: 3 })
    })

    it('returns null without the capability bit (old hub)', () => {
        expect(extractTelemetryCapability({ githubPrAwareness: { enabled: true, source: 'env' } })).toBeNull()
        expect(extractTelemetryCapability(null)).toBeNull()
        expect(extractTelemetryCapability('telemetry')).toBeNull()
        expect(extractTelemetryCapability({ telemetry: false, telemetryLevel: 2 })).toBeNull()
    })
})

describe('old hub negotiation', () => {
    it('disables on features 404 and re-probes every 30min until the hub upgrades', async () => {
        kit.setFeaturesStatus(404)
        installForTest(kit)
        await settle()
        expect(state.enabled).toBe(false)
        expect(state.level).toBe(0)

        // capture is a silent no-op while disabled
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(0)

        // 30min later the hub has telemetry: probe re-enables.
        kit.setFeaturesStatus(200)
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        expect(state.enabled).toBe(true)
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(1)
    })

    it('disables when the capability bit is absent (200 without telemetry key)', async () => {
        kit.setCapability(false)
        installForTest(kit)
        await settle()
        expect(state.enabled).toBe(false)
        kit.setCapability(true)
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        expect(state.enabled).toBe(true)
    })

    it('treats level 0 from the hub as telemetry-off', async () => {
        installForTest(kit, 0)
        await settle()
        expect(state.enabled).toBe(false)
        expect(state.level).toBe(0)
    })
})

describe('level gating', () => {
    it('drops events whose kind minLevel exceeds the negotiated level', async () => {
        installForTest(kit, 1)
        await settle()
        expect(state.level).toBe(1)
        // web_vital is minLevel 2
        captureEvent('perf', 'web_vital', { cls: 0.01 })
        expect(queuedEventsForTest()).toHaveLength(0)
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(1)
    })

    it('accepts minLevel-2 kinds at L2', async () => {
        installForTest(kit, 2)
        await settle()
        expect(state.level).toBe(2)
        captureEvent('perf', 'web_vital', { cls: 0.01 })
        expect(queuedEventsForTest()).toHaveLength(1)
    })

    it('unknown kinds and domain mismatches are dropped silently', async () => {
        installForTest(kit, 3)
        await settle()
        captureEvent('diag', 'not_a_kind', {})
        captureEvent('ux', 'js_error', { name: 'x', messageHead: 'y' }) // domain mismatch
        captureEvent('diag', 'js_error', { name: 'x', messageHead: 'y' }) // ok
        expect(queuedEventsForTest()).toHaveLength(1)
        expect(queuedEventsForTest()[0]?.kind).toBe('js_error')
    })
})

describe('refresh failures: transient vs deterministic', () => {
    it('a 5xx during a level refresh keeps the negotiated state — capture keeps working (hub restart)', async () => {
        installForTest(kit, 1)
        await settle()
        expect(state.enabled).toBe(true)
        kit.setFeaturesStatus(503)
        await probeCapability()
        await settle()
        expect(state.enabled).toBe(true)
        expect(state.level).toBe(1)
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(1)
    })

    it('a network failure during a level refresh keeps the negotiated state', async () => {
        installForTest(kit, 1)
        await settle()
        kit.failFeatures('network')
        await probeCapability()
        await settle()
        expect(state.enabled).toBe(true)
        expect(state.level).toBe(1)
        kit.failFeatures('off')
    })

    it('a 404 during refresh still disables (deterministic old hub / endpoint gone)', async () => {
        installForTest(kit, 1)
        await settle()
        kit.setFeaturesStatus(404)
        await probeCapability()
        await settle()
        expect(state.enabled).toBe(false)
        expect(state.level).toBe(0)
    })
})

describe('30min re-probe self-continuation', () => {
    it('keeps probing every 30min while disabled, and stops the chain once enabled', async () => {
        kit.setCapability(false)
        installForTest(kit)
        await settle()
        await settle()
        const featureRequests = () => kit.requests.filter((r) => r.url.includes('/api/features')).length
        const afterInstall = featureRequests()

        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        await settle()
        expect(featureRequests()).toBe(afterInstall + 1)
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        await settle()
        expect(featureRequests()).toBe(afterInstall + 2)

        // the hub upgrades: the next round enables and the chain stops
        kit.setCapability(true)
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        await settle()
        await settle()
        expect(state.enabled).toBe(true)
        const whenEnabled = featureRequests()
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        await settle()
        await settle()
        expect(featureRequests()).toBe(whenEnabled)
    })
})

describe('token harvesting via the authProxy single fetch point', () => {
    it('probes only once a Bearer token has been observed', async () => {
        forceEnableTelemetryForTest()
        installTelemetry({ getAuthToken: () => null, baseUrl: 'https://hub.example' })
        await settle()
        // No token anywhere: probe defers, SDK stays disabled, capture no-op.
        expect(state.enabled).toBe(false)
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(0)

        // A wrapped request carrying the JWT both notes the token and
        // triggers the throttled re-probe.
        await fetchThroughAuthProxy('https://hub.example/api/sessions', {
            headers: { authorization: 'Bearer jwt-live-token' },
        })
        expect(state.lastSeenBearer).toBe('jwt-live-token')
        await settle()
        expect(state.enabled).toBe(true)
        captureEvent('diag', 'load_slow', { phase: 'session-detail', durationMs: 1, fromCache: false })
        expect(queuedEventsForTest()).toHaveLength(1)

        // The SDK uplink itself carries the self-header → never observed.
        const posts = kit.requests.filter((r) => r.url.includes('/api/features'))
        expect(posts.length).toBeGreaterThan(0)
    })
})
