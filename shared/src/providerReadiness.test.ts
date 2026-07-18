import { describe, expect, test } from 'bun:test'
import {
    AGENT_FLAVORS,
    PROVIDER_CAPABILITIES,
    PROVIDER_READINESS_FUTURE_SKEW_MS,
    PROVIDER_READINESS_MAX_AGE_MS,
    getProviderAvailability,
    getProviderRecoveryCommand,
    getProviderSelectionIssue,
    resolveProviderSelectionMode,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessMap,
} from './providerReadiness'
import {
    MachineMetadataSchema,
    ProviderReadinessMapSchema,
    ProviderReadinessSchema,
} from './schemas'

const NOW = 1_800_000_000_000

function readyEntry(
    flavor: AgentFlavor,
    overrides: Partial<ProviderReadiness> = {},
): ProviderReadiness {
    return {
        status: 'ready',
        installed: true,
        authenticated: true,
        authCheck: 'command',
        version: '1.2.3',
        ...PROVIDER_CAPABILITIES[flavor],
        checkedAt: NOW,
        ...overrides,
    }
}

function readyMap(flavor: AgentFlavor, overrides: Partial<ProviderReadiness> = {}): ProviderReadinessMap {
    return { [flavor]: readyEntry(flavor, overrides) }
}

describe('provider readiness protocol', () => {
    test('uses one canonical ordered flavor list', () => {
        expect(AGENT_FLAVORS).toEqual([
            'claude',
            'claude-deepseek',
            'claude-ark',
            'cc-api',
            'codex',
            'agy',
            'grok',
            'opencode',
            'cursor',
            'hermes-moa',
        ])
        expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([...AGENT_FLAVORS].sort())
    })

    test('accepts a strict known-provider map and rejects unknown providers', () => {
        const validMap = readyMap('grok')
        expect(ProviderReadinessMapSchema.parse(validMap).grok?.status).toBe('ready')
        expect(() => ProviderReadinessMapSchema.parse({ fake: readyEntry('grok') })).toThrow()
    })

    test('rejects unknown entry fields and inconsistent status facts', () => {
        expect(() => ProviderReadinessSchema.parse({
            ...readyEntry('grok'),
            rawOutput: 'must never cross the protocol boundary',
        })).toThrow()
        expect(() => ProviderReadinessSchema.parse(readyEntry('grok', {
            status: 'ready',
            authenticated: false,
        }))).toThrow()
        expect(() => ProviderReadinessSchema.parse(readyEntry('grok', {
            status: 'not-installed',
            installed: true,
        }))).toThrow()
        expect(() => ProviderReadinessSchema.parse(readyEntry('grok', {
            status: 'not-authenticated',
            authenticated: true,
        }))).toThrow()
        expect(() => ProviderReadinessSchema.parse(readyEntry('grok', {
            status: 'unsupported-version',
            version: null,
        }))).toThrow()
    })

    test('allows ready providers whose safe auth check is unavailable without claiming auth', () => {
        expect(ProviderReadinessSchema.parse(readyEntry('agy', {
            authenticated: null,
            authCheck: 'unavailable',
        })).status).toBe('ready')
        expect(() => ProviderReadinessSchema.parse(readyEntry('codex', {
            authenticated: null,
            authCheck: 'command',
        }))).toThrow()
    })

    test('centralizes strict machine metadata while keeping readiness backward-compatible', () => {
        const base = {
            host: 'runner.example',
            platform: 'darwin',
            happyCliVersion: '1.2.3',
        }
        expect(MachineMetadataSchema.parse(base).providerReadiness).toBeUndefined()
        expect(MachineMetadataSchema.parse({
            ...base,
            providerReadiness: readyMap('grok'),
        }).providerReadiness?.grok?.status).toBe('ready')
        expect(() => MachineMetadataSchema.parse({ ...base, unknown: true })).toThrow()
    })
})

describe('static provider capabilities', () => {
    test('keeps Grok experimental with the ACP minimum and exact recovery command', () => {
        expect(PROVIDER_CAPABILITIES.grok).toMatchObject({
            minimumVersion: '0.2.93',
            models: ['auto', 'grok-4.5'],
            experimental: true,
        })
        expect(PROVIDER_CAPABILITIES.grok.efforts.auto).toEqual(['auto', 'low', 'medium', 'high'])
        expect(getProviderRecoveryCommand('grok', 'not-authenticated')).toBe('grok login --device-code')
        expect(getProviderRecoveryCommand('grok', 'probe-failed')).toBeUndefined()
        expect(getProviderRecoveryCommand('codex', 'not-authenticated')).toBeUndefined()
    })

    test('reports modes from the existing per-flavor permission contract', () => {
        expect(PROVIDER_CAPABILITIES.codex.modes).toEqual(['default', 'read-only', 'safe-yolo', 'yolo'])
        expect(PROVIDER_CAPABILITIES.cursor.modes).toEqual(['default', 'plan', 'ask', 'yolo'])
        expect(PROVIDER_CAPABILITIES['hermes-moa'].modes).toEqual(['default', 'yolo'])
    })

    test('keeps every non-Grok provider non-experimental', () => {
        for (const flavor of AGENT_FLAVORS) {
            expect(PROVIDER_CAPABILITIES[flavor].experimental).toBe(flavor === 'grok')
        }
    })
})

describe('provider availability', () => {
    test('fails closed when readiness or the selected provider is missing', () => {
        expect(getProviderAvailability(undefined, 'grok', NOW)).toMatchObject({
            ok: false,
            code: 'provider-readiness-missing',
        })
        expect(getProviderAvailability({}, 'grok', NOW)).toMatchObject({
            ok: false,
            code: 'provider-readiness-missing',
        })
    })

    test('rejects stale and future-skewed checks', () => {
        expect(getProviderAvailability(readyMap('grok', {
            checkedAt: NOW - PROVIDER_READINESS_MAX_AGE_MS - 1,
        }), 'grok', NOW)).toMatchObject({
            ok: false,
            code: 'provider-readiness-stale',
        })
        expect(getProviderAvailability(readyMap('grok', {
            checkedAt: NOW + PROVIDER_READINESS_FUTURE_SKEW_MS + 1,
        }), 'grok', NOW)).toMatchObject({
            ok: false,
            code: 'provider-readiness-stale',
        })
        expect(getProviderAvailability(readyMap('grok', {
            checkedAt: NOW - PROVIDER_READINESS_MAX_AGE_MS,
        }), 'grok', NOW).ok).toBe(true)
        expect(getProviderAvailability(readyMap('grok', {
            checkedAt: NOW + PROVIDER_READINESS_FUTURE_SKEW_MS,
        }), 'grok', NOW).ok).toBe(true)
    })

    test('maps normalized non-ready states to stable issue codes', () => {
        const cases = [
            ['not-installed', 'provider-not-installed'],
            ['not-authenticated', 'provider-not-authenticated'],
            ['unsupported-version', 'provider-version-unsupported'],
            ['probe-failed', 'provider-probe-failed'],
        ] as const

        for (const [status, code] of cases) {
            const entry = status === 'not-installed'
                ? readyEntry('grok', { status, installed: false, authenticated: null, version: null })
                : status === 'not-authenticated'
                    ? readyEntry('grok', { status, authenticated: false })
                    : readyEntry('grok', { status })
            expect(getProviderAvailability({ grok: entry }, 'grok', NOW)).toMatchObject({
                ok: false,
                code,
            })
        }
    })

    test('returns the normalized entry only when ready and fresh', () => {
        const map = readyMap('grok')
        expect(getProviderAvailability(map, 'grok', NOW)).toEqual({
            ok: true,
            entry: map.grok!,
        })
    })
})

describe('provider selection validation', () => {
    test('normalizes legacy yolo exactly like each provider launcher', () => {
        expect(resolveProviderSelectionMode('claude', undefined, true)).toBe('bypassPermissions')
        expect(resolveProviderSelectionMode('claude-deepseek', null, true)).toBe('bypassPermissions')
        expect(resolveProviderSelectionMode('codex', undefined, true)).toBe('yolo')
        expect(resolveProviderSelectionMode('cursor', undefined, true)).toBe('yolo')
        expect(resolveProviderSelectionMode('opencode', undefined, true)).toBe('yolo')
        expect(resolveProviderSelectionMode('claude', 'plan', true)).toBe('plan')
        expect(resolveProviderSelectionMode('claude', undefined, false)).toBe('default')
    })

    test('rejects unreported model, effort, and mode choices', () => {
        const map = readyMap('grok')
        expect(getProviderSelectionIssue(map, 'grok', { model: 'not-reported' }, NOW)?.code)
            .toBe('provider-model-unavailable')
        expect(getProviderSelectionIssue(map, 'grok', { model: 'grok-4.5', effort: 'max' }, NOW)?.code)
            .toBe('provider-effort-unavailable')
        expect(getProviderSelectionIssue(map, 'grok', { mode: 'plan' }, NOW)?.code)
            .toBe('provider-mode-unavailable')
    })

    test('allows an unlisted pass-through model only when resuming an existing session', () => {
        expect(getProviderSelectionIssue(readyMap('claude'), 'claude', {
            model: 'opus[1m]',
            effort: 'max',
            resume: true,
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('codex'), 'codex', {
            model: 'custom-codex-model',
            effort: 'ultra',
            resume: true,
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('grok'), 'grok', {
            model: 'custom-grok-model',
            effort: 'high',
            resume: true,
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('claude-ark'), 'claude-ark', {
            model: 'custom-ark-model',
            effort: 'max',
            resume: true,
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('cc-api'), 'cc-api', {
            model: 'custom-cc-api-model',
            effort: 'high',
            resume: true,
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('cursor'), 'cursor', {
            model: 'custom-cursor-model',
            resume: true,
        }, NOW)).toBeNull()

        expect(getProviderSelectionIssue(readyMap('claude'), 'claude', {
            model: 'opus[1m]',
        }, NOW)?.code).toBe('provider-model-unavailable')
        expect(getProviderSelectionIssue(readyMap('agy'), 'agy', {
            model: 'custom-agy-model',
            resume: true,
        }, NOW)?.code).toBe('provider-model-unavailable')
        expect(getProviderSelectionIssue(readyMap('hermes-moa'), 'hermes-moa', {
            model: 'custom-hermes-preset',
            resume: true,
        }, NOW)?.code).toBe('provider-model-unavailable')
    })

    test('uses a supported request token only to override local profile authentication', () => {
        const signedOutClaude = readyMap('claude', {
            status: 'not-authenticated',
            authenticated: false,
        })
        const requestTokenSelection = {
            model: 'sonnet',
            requestTokenAuth: true,
        }

        expect(getProviderSelectionIssue(
            signedOutClaude,
            'claude',
            requestTokenSelection,
            NOW,
        )).toBeNull()
        expect(getProviderSelectionIssue(signedOutClaude, 'claude', { model: 'sonnet' }, NOW)?.code)
            .toBe('provider-not-authenticated')
        expect(getProviderSelectionIssue(readyMap('claude', {
            status: 'not-installed',
            installed: false,
            authenticated: null,
            version: null,
        }), 'claude', requestTokenSelection, NOW)?.code).toBe('provider-not-installed')
        expect(getProviderSelectionIssue(readyMap('grok', {
            status: 'not-authenticated',
            authenticated: false,
        }), 'grok', requestTokenSelection, NOW)?.code).toBe('provider-not-authenticated')
    })

    test('accepts reported choices and uses auto effort capabilities when model is omitted', () => {
        const map = readyMap('grok')
        expect(getProviderSelectionIssue(map, 'grok', {
            model: 'grok-4.5',
            effort: 'high',
            mode: 'safe-yolo',
        }, NOW)).toBeNull()
        expect(getProviderSelectionIssue(map, 'grok', { effort: 'low' }, NOW)).toBeNull()
    })

    test('returns readiness issues before evaluating selections', () => {
        expect(getProviderSelectionIssue(undefined, 'grok', { model: 'grok-4.5' }, NOW)?.code)
            .toBe('provider-readiness-missing')
    })

    test('validates legacy yolo and resume capability before launch', () => {
        expect(getProviderSelectionIssue(readyMap('claude', {
            modes: ['default'],
        }), 'claude', { yolo: true }, NOW)?.code).toBe('provider-mode-unavailable')
        expect(getProviderSelectionIssue(readyMap('codex', {
            resume: false,
        }), 'codex', { resume: true }, NOW)?.code).toBe('provider-resume-unavailable')
        expect(getProviderSelectionIssue(readyMap('codex'), 'codex', {
            yolo: true,
            resume: true,
        }, NOW)).toBeNull()
    })

    test('rejects an omitted model when the effective provider default is not advertised', () => {
        expect(getProviderSelectionIssue(readyMap('agy', {
            models: ['Gemini 3.5 Flash (Low)'],
        }), 'agy', {}, NOW)?.code).toBe('provider-model-unavailable')
    })

    test('resolves the DeepSeek default model and max effort when omitted', () => {
        expect(getProviderSelectionIssue(readyMap('claude-deepseek'), 'claude-deepseek', {}, NOW)).toBeNull()
        expect(getProviderSelectionIssue(readyMap('claude-deepseek', {
            efforts: { 'deepseek-v4-pro[1m]': ['auto', 'high'] },
        }), 'claude-deepseek', {}, NOW)?.code).toBe('provider-effort-unavailable')
    })

    test('rejects an omitted mode when the effective default mode is not advertised', () => {
        expect(getProviderSelectionIssue(readyMap('grok', {
            modes: ['safe-yolo'],
        }), 'grok', {}, NOW)?.code).toBe('provider-mode-unavailable')
    })
})
