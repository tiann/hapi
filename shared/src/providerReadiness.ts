import {
    AGY_MODEL_PRESETS,
    ARK_MODEL_PRESETS,
    CC_API_MODEL_PRESETS,
    CLAUDE_DEEPSEEK_MODEL_PRESETS,
    CLAUDE_EFFORT_PRESETS,
    CLAUDE_MODEL_PRESETS,
    DEFAULT_AGY_MODEL,
    DEFAULT_ARK_MODEL,
    DEFAULT_CC_API_MODEL,
    DEFAULT_CLAUDE_DEEPSEEK_MODEL,
    DEFAULT_HERMES_MOA_PRESET,
    HERMES_MOA_PRESETS,
    getCcApiModelEffortPresets,
    getClaudeDeepSeekModelEffortPresets,
} from './models'
import {
    AGENT_FLAVORS,
    getPermissionModesForFlavor,
    type AgentFlavor,
    type PermissionMode,
} from './modes'
import type {
    ProviderReadiness,
    ProviderReadinessMap,
    ProviderReadinessStatus,
} from './schemas'

export { AGENT_FLAVORS }
export type { AgentFlavor } from './modes'
export type { ProviderReadiness, ProviderReadinessMap, ProviderReadinessStatus } from './schemas'

export const PROVIDER_READINESS_READY_REFRESH_MS = 5 * 60_000
export const PROVIDER_READINESS_RETRY_REFRESH_MS = 60_000
export const PROVIDER_READINESS_MAX_AGE_MS = 10 * 60_000
export const PROVIDER_READINESS_FUTURE_SKEW_MS = 60_000

export const CODEX_PROVIDER_MODELS = [
    'auto',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
] as const

const CODEX_AUTO_EFFORTS = ['default', 'none', 'low', 'medium', 'high', 'xhigh']
const CODEX_GPT_56_EFFORTS = ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
const CODEX_GPT_56_ULTRA_EFFORTS = [...CODEX_GPT_56_EFFORTS, 'ultra']
const CODEX_SPARK_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh']

export const CODEX_PROVIDER_EFFORTS: Record<string, string[]> = {
    auto: [...CODEX_AUTO_EFFORTS],
    'gpt-5.6-sol': [...CODEX_GPT_56_ULTRA_EFFORTS],
    'gpt-5.6-terra': [...CODEX_GPT_56_ULTRA_EFFORTS],
    'gpt-5.6-luna': [...CODEX_GPT_56_EFFORTS],
    'gpt-5.5': [...CODEX_AUTO_EFFORTS],
    'gpt-5.4': [...CODEX_AUTO_EFFORTS],
    'gpt-5.4-mini': [...CODEX_AUTO_EFFORTS],
    'gpt-5.3-codex-spark': [...CODEX_SPARK_EFFORTS],
}

export const GROK_PROVIDER_MODELS = ['auto', 'grok-4.5'] as const
export const GROK_PROVIDER_EFFORTS = ['auto', 'low', 'medium', 'high'] as const

export type ProviderCapabilityDescriptor = Pick<
    ProviderReadiness,
    'minimumVersion' | 'modes' | 'models' | 'efforts' | 'attachments' | 'resume' | 'experimental'
>

function effortMap(models: readonly string[], efforts: readonly string[]): Record<string, string[]> {
    return Object.fromEntries(models.map((model) => [model, [...efforts]]))
}

function descriptor(
    flavor: AgentFlavor,
    options: {
        minimumVersion?: string
        models?: readonly string[]
        efforts?: Record<string, readonly string[]>
        experimental?: boolean
    } = {},
): ProviderCapabilityDescriptor {
    return {
        minimumVersion: options.minimumVersion ?? null,
        modes: [...getPermissionModesForFlavor(flavor)],
        models: [...(options.models ?? [])],
        efforts: Object.fromEntries(
            Object.entries(options.efforts ?? {}).map(([model, efforts]) => [model, [...efforts]])
        ),
        attachments: true,
        resume: true,
        experimental: options.experimental ?? false,
    }
}

const claudeModels = ['auto', ...CLAUDE_MODEL_PRESETS]
const claudeEfforts = ['auto', ...CLAUDE_EFFORT_PRESETS]
const claudeDeepSeekModels = [...CLAUDE_DEEPSEEK_MODEL_PRESETS]
const arkModels = [...ARK_MODEL_PRESETS]
const ccApiModels = [...CC_API_MODEL_PRESETS, 'glm-5.2']

export const PROVIDER_CAPABILITIES: Record<AgentFlavor, ProviderCapabilityDescriptor> = {
    claude: descriptor('claude', {
        models: claudeModels,
        efforts: effortMap(claudeModels, claudeEfforts),
    }),
    'claude-deepseek': descriptor('claude-deepseek', {
        models: claudeDeepSeekModels,
        efforts: Object.fromEntries(claudeDeepSeekModels.map((model) => [
            model,
            ['auto', ...getClaudeDeepSeekModelEffortPresets(model)],
        ])),
    }),
    'claude-ark': descriptor('claude-ark', {
        models: arkModels,
        efforts: effortMap(arkModels, claudeEfforts),
    }),
    'cc-api': descriptor('cc-api', {
        models: ccApiModels,
        efforts: Object.fromEntries(ccApiModels.map((model) => [
            model,
            ['auto', ...getCcApiModelEffortPresets(model)],
        ])),
    }),
    codex: descriptor('codex', {
        models: CODEX_PROVIDER_MODELS,
        efforts: CODEX_PROVIDER_EFFORTS,
    }),
    agy: descriptor('agy', { models: AGY_MODEL_PRESETS }),
    grok: descriptor('grok', {
        minimumVersion: '0.2.93',
        models: GROK_PROVIDER_MODELS,
        efforts: effortMap(GROK_PROVIDER_MODELS, GROK_PROVIDER_EFFORTS),
        experimental: true,
    }),
    opencode: descriptor('opencode'),
    cursor: descriptor('cursor'),
    'hermes-moa': descriptor('hermes-moa', { models: HERMES_MOA_PRESETS }),
}

export const PROVIDER_READINESS_ISSUE_CODES = [
    'provider-readiness-missing',
    'provider-readiness-stale',
    'provider-not-installed',
    'provider-not-authenticated',
    'provider-version-unsupported',
    'provider-probe-failed',
    'provider-model-unavailable',
    'provider-effort-unavailable',
    'provider-mode-unavailable',
    'provider-resume-unavailable',
] as const

export type ProviderReadinessIssueCode = typeof PROVIDER_READINESS_ISSUE_CODES[number]

export type ProviderReadinessIssue = {
    ok: false
    code: ProviderReadinessIssueCode
    message: string
    recoveryCommand?: string
}

export type ProviderAvailability =
    | { ok: true; entry: ProviderReadiness }
    | ProviderReadinessIssue

export type ProviderSelection = {
    model?: string | null
    effort?: string | null
    mode?: string | null
    yolo?: boolean | null
    resume?: boolean | null
    /** A request-scoped Claude/Codex token replaces only local-profile authentication. */
    requestTokenAuth?: boolean | null
}

const PROVIDER_RESUME_PASSTHROUGH_MODEL_FLAVORS = new Set<AgentFlavor>([
    'claude',
    'claude-ark',
    'cc-api',
    'codex',
    'grok',
    'cursor',
])

const PROVIDER_REQUEST_TOKEN_AUTH_FLAVORS = new Set<AgentFlavor>(['claude', 'codex'])

const PROVIDER_DEFAULT_MODELS = {
    claude: 'auto',
    'claude-deepseek': DEFAULT_CLAUDE_DEEPSEEK_MODEL,
    'claude-ark': DEFAULT_ARK_MODEL,
    'cc-api': DEFAULT_CC_API_MODEL,
    codex: 'auto',
    agy: DEFAULT_AGY_MODEL,
    grok: 'auto',
    opencode: null,
    cursor: null,
    'hermes-moa': DEFAULT_HERMES_MOA_PRESET,
} satisfies Record<AgentFlavor, string | null>

const PROVIDER_DEFAULT_EFFORTS = {
    claude: 'auto',
    'claude-deepseek': 'max',
    'claude-ark': 'auto',
    'cc-api': 'auto',
    codex: 'default',
    agy: null,
    grok: 'auto',
    opencode: null,
    cursor: null,
    'hermes-moa': null,
} satisfies Record<AgentFlavor, string | null>

export function getProviderRecoveryCommand(
    flavor: AgentFlavor,
    status: ProviderReadinessStatus,
): string | undefined {
    return flavor === 'grok' && status === 'not-authenticated'
        ? 'grok login --device-code'
        : undefined
}

function unavailable(
    flavor: AgentFlavor,
    entry: ProviderReadiness,
): ProviderReadinessIssue {
    const recoveryCommand = getProviderRecoveryCommand(flavor, entry.status)
    const issue = (() => {
        switch (entry.status) {
            case 'not-installed':
                return { code: 'provider-not-installed' as const, message: `${flavor} is not installed on this machine.` }
            case 'not-authenticated':
                return { code: 'provider-not-authenticated' as const, message: `${flavor} is not authenticated on this machine.` }
            case 'unsupported-version':
                return { code: 'provider-version-unsupported' as const, message: `${flavor} does not meet the minimum supported version.` }
            case 'probe-failed':
                return { code: 'provider-probe-failed' as const, message: `${flavor} readiness could not be checked.` }
            case 'ready':
                throw new Error('ready providers are not unavailable')
        }
    })()

    return {
        ok: false,
        ...issue,
        ...(recoveryCommand ? { recoveryCommand } : {}),
    }
}

export function getProviderAvailability(
    readiness: ProviderReadinessMap | null | undefined,
    flavor: AgentFlavor,
    now = Date.now(),
): ProviderAvailability {
    const entry = readiness?.[flavor]
    if (!entry) {
        return {
            ok: false,
            code: 'provider-readiness-missing',
            message: `Provider readiness is missing for ${flavor}. Update or restart the HAPI Runner.`,
        }
    }

    const age = now - entry.checkedAt
    if (age > PROVIDER_READINESS_MAX_AGE_MS || age < -PROVIDER_READINESS_FUTURE_SKEW_MS) {
        return {
            ok: false,
            code: 'provider-readiness-stale',
            message: `Provider readiness is stale for ${flavor}. Update or restart the HAPI Runner.`,
        }
    }

    return entry.status === 'ready'
        ? { ok: true, entry }
        : unavailable(flavor, entry)
}

function selectionIssue(
    code: Extract<
        ProviderReadinessIssueCode,
        | 'provider-model-unavailable'
        | 'provider-effort-unavailable'
        | 'provider-mode-unavailable'
        | 'provider-resume-unavailable'
    >,
    message: string,
): ProviderReadinessIssue {
    return { ok: false, code, message }
}

export function resolveProviderSelectionMode(
    flavor: AgentFlavor,
    mode: string | null | undefined,
    yolo: boolean | null | undefined,
): string {
    const explicitMode = mode?.trim()
    if (explicitMode) return explicitMode
    if (!yolo) return 'default'

    return flavor === 'claude'
        || flavor === 'claude-deepseek'
        || flavor === 'claude-ark'
        || flavor === 'cc-api'
        ? 'bypassPermissions'
        : 'yolo'
}

export function resolveProviderSelectionModel(
    flavor: AgentFlavor,
    model: string | null | undefined,
): string | null {
    if (flavor === 'opencode') return null
    return model?.trim() || PROVIDER_DEFAULT_MODELS[flavor]
}

export function resolveProviderSelectionEffort(
    flavor: AgentFlavor,
    effort: string | null | undefined,
): string | null {
    return effort?.trim() || PROVIDER_DEFAULT_EFFORTS[flavor]
}

export function getProviderSelectionIssue(
    readiness: ProviderReadinessMap | null | undefined,
    flavor: AgentFlavor,
    selection: ProviderSelection,
    now = Date.now(),
): ProviderReadinessIssue | null {
    const availability = getProviderAvailability(readiness, flavor, now)
    const requestTokenEntry = !availability.ok
        && availability.code === 'provider-not-authenticated'
        && selection.requestTokenAuth === true
        && PROVIDER_REQUEST_TOKEN_AUTH_FLAVORS.has(flavor)
        ? readiness?.[flavor]
        : undefined
    if (!availability.ok && !requestTokenEntry) return availability

    const entry = availability.ok ? availability.entry : requestTokenEntry!
    if (selection.resume === true && !entry.resume) {
        return selectionIssue(
            'provider-resume-unavailable',
            `${flavor} does not support resume on this machine.`,
        )
    }

    const model = resolveProviderSelectionModel(flavor, selection.model)
    const unlistedModel = Boolean(model && !entry.models.includes(model))
    const passThroughResumeModel = unlistedModel
        && selection.resume === true
        && PROVIDER_RESUME_PASSTHROUGH_MODEL_FLAVORS.has(flavor)
    if (unlistedModel && !passThroughResumeModel) {
        return selectionIssue(
            'provider-model-unavailable',
            `Model ${model} is not available for ${flavor} on this machine.`,
        )
    }

    const effort = resolveProviderSelectionEffort(flavor, selection.effort)
    if (effort && !passThroughResumeModel) {
        const effortModel = model || 'auto'
        const allowedEfforts = entry.efforts[effortModel] ?? entry.efforts.auto ?? []
        if (!allowedEfforts.includes(effort)) {
            return selectionIssue(
                'provider-effort-unavailable',
                `Effort ${effort} is not available for ${flavor} on this machine.`,
            )
        }
    }

    const mode = resolveProviderSelectionMode(flavor, selection.mode, selection.yolo)
    if (mode && !entry.modes.includes(mode as PermissionMode)) {
        return selectionIssue(
            'provider-mode-unavailable',
            `Permission mode ${mode} is not available for ${flavor} on this machine.`,
        )
    }

    return null
}
