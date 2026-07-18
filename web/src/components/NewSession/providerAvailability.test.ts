import { describe, expect, it } from 'vitest'
import {
    PROVIDER_CAPABILITIES,
    PROVIDER_READINESS_MAX_AGE_MS,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessMap
} from '@hapi/protocol'
import {
    formatProviderIssue,
    getNewSessionProviderIssue,
    getProviderEfforts,
    getProviderState,
    intersectReportedValues,
    isProviderSelectionReady,
    reconcileReportedValue,
    resolveReadyAgent
} from './providerAvailability'

const NOW = 1_800_000_000_000

function entry(flavor: AgentFlavor, overrides: Partial<ProviderReadiness> = {}): ProviderReadiness {
    const authCheck = flavor === 'grok' ? 'credential-file' as const : 'command' as const
    return {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck,
        version: flavor === 'grok' ? '0.2.101' : '1.2.3',
        ...PROVIDER_CAPABILITIES[flavor],
        checkedAt: NOW,
        ...overrides
    }
}

describe('New Session provider availability', () => {
    it('falls back from an unavailable preference to the first ready provider', () => {
        const readiness: ProviderReadinessMap = {
            claude: entry('claude', { status: 'not-authenticated', authenticated: false }),
            grok: entry('grok')
        }

        expect(resolveReadyAgent(readiness, 'claude', NOW)).toBe('grok')
        expect(getProviderState(readiness, 'claude', NOW)).toMatchObject({
            ready: false,
            issue: { code: 'provider-not-authenticated' }
        })
        expect(getProviderState(readiness, 'grok', NOW)).toMatchObject({ ready: true })
    })

    it('intersects reported values and resets invalid selections deterministically', () => {
        expect(intersectReportedValues(['auto', 'grok-4.5', 'other'], ['auto', 'grok-4.5']))
            .toEqual(['auto', 'grok-4.5'])
        expect(reconcileReportedValue('other', ['auto', 'grok-4.5'], 'auto')).toBe('auto')
        expect(reconcileReportedValue('grok-4.5', ['auto', 'grok-4.5'], 'auto')).toBe('grok-4.5')
        expect(getProviderEfforts(entry('grok'), 'grok-4.5')).toEqual(['auto', 'low', 'medium', 'high'])
    })

    it('blocks Create for missing, stale, non-ready, and mismatched selections', () => {
        expect(isProviderSelectionReady(undefined, 'grok', {}, NOW)).toBe(false)
        expect(isProviderSelectionReady({
            grok: entry('grok', { checkedAt: NOW - PROVIDER_READINESS_MAX_AGE_MS - 1 })
        }, 'grok', {}, NOW)).toBe(false)
        expect(isProviderSelectionReady({
            grok: entry('grok', { status: 'not-authenticated', authenticated: false })
        }, 'grok', {}, NOW)).toBe(false)
        expect(isProviderSelectionReady({ grok: entry('grok') }, 'grok', {
            model: 'unreported'
        }, NOW)).toBe(false)
        expect(isProviderSelectionReady({ grok: entry('grok') }, 'grok', {
            model: 'grok-4.5', effort: 'high', mode: 'safe-yolo'
        }, NOW)).toBe(true)
        expect(isProviderSelectionReady({
            claude: entry('claude', { modes: ['default'] })
        }, 'claude', { yolo: true }, NOW)).toBe(false)
    })

    it('formats an actionable localized reason without provider output', () => {
        const issue = getNewSessionProviderIssue({
            grok: entry('grok', { status: 'not-authenticated', authenticated: false })
        }, 'grok', {}, NOW)
        expect(issue).not.toBeNull()

        const messages: Record<string, string> = {
            'newSession.provider.notAuthenticated': '{agent} is not authenticated.',
            'newSession.provider.recovery': 'Run: {command}'
        }
        const text = formatProviderIssue(issue!, 'Grok', (key, params) => {
            return (messages[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
        })

        expect(text).toBe('Grok is not authenticated. Run: grok login --device-code')
    })
})
