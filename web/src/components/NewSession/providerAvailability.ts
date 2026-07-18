import {
    PROVIDER_CAPABILITIES,
    getProviderAvailability,
    getProviderSelectionIssue,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessIssue,
    type ProviderReadinessIssueCode,
    type ProviderReadinessMap,
    type ProviderSelection
} from '@hapi/protocol'
import type { AgentType } from './types'

export const NEW_SESSION_AGENT_ORDER: readonly AgentType[] = [
    'claude',
    'claude-deepseek',
    'claude-ark',
    'cc-api',
    'codex',
    'cursor',
    'agy',
    'grok',
    'opencode',
    'hermes-moa'
]

export type NewSessionProviderState = {
    ready: boolean
    entry: ProviderReadiness | null
    issue: ProviderReadinessIssue | null
    experimental: boolean
}

export function getProviderState(
    readiness: ProviderReadinessMap | null | undefined,
    flavor: AgentFlavor,
    now = Date.now()
): NewSessionProviderState {
    const availability = getProviderAvailability(readiness, flavor, now)
    const entry = readiness?.[flavor] ?? null
    return availability.ok
        ? {
            ready: true,
            entry: availability.entry,
            issue: null,
            experimental: availability.entry.experimental
        }
        : {
            ready: false,
            entry,
            issue: availability,
            experimental: entry?.experimental ?? PROVIDER_CAPABILITIES[flavor].experimental
        }
}

export function resolveReadyAgent(
    readiness: ProviderReadinessMap | null | undefined,
    preferred: AgentType,
    now = Date.now()
): AgentType {
    if (getProviderAvailability(readiness, preferred, now).ok) return preferred
    return NEW_SESSION_AGENT_ORDER.find((flavor) => (
        getProviderAvailability(readiness, flavor, now).ok
    )) ?? preferred
}

export function intersectReportedValues<T extends string>(
    configured: readonly T[],
    reported: readonly string[]
): T[] {
    const allowed = new Set(reported)
    return configured.filter((value) => allowed.has(value))
}

export function reconcileReportedValue<T extends string>(
    current: T,
    allowed: readonly T[],
    fallback: T
): T {
    return allowed.includes(current) ? current : (allowed[0] ?? fallback)
}

export function getProviderEfforts(
    entry: ProviderReadiness | null | undefined,
    model: string | null | undefined
): string[] {
    if (!entry) return []
    const normalizedModel = model?.trim() || 'auto'
    return [...(entry.efforts[normalizedModel] ?? entry.efforts.auto ?? [])]
}

export function getNewSessionProviderIssue(
    readiness: ProviderReadinessMap | null | undefined,
    flavor: AgentFlavor,
    selection: ProviderSelection,
    now = Date.now()
): ProviderReadinessIssue | null {
    return getProviderSelectionIssue(readiness, flavor, selection, now)
}

export function isProviderSelectionReady(
    readiness: ProviderReadinessMap | null | undefined,
    flavor: AgentFlavor,
    selection: ProviderSelection,
    now = Date.now()
): boolean {
    return getNewSessionProviderIssue(readiness, flavor, selection, now) === null
}

type Translate = (key: string, params?: Record<string, string | number>) => string

const PROVIDER_ISSUE_KEYS: Record<ProviderReadinessIssueCode, string> = {
    'provider-readiness-missing': 'newSession.provider.readinessMissing',
    'provider-readiness-stale': 'newSession.provider.readinessStale',
    'provider-not-installed': 'newSession.provider.notInstalled',
    'provider-not-authenticated': 'newSession.provider.notAuthenticated',
    'provider-version-unsupported': 'newSession.provider.versionUnsupported',
    'provider-probe-failed': 'newSession.provider.probeFailed',
    'provider-model-unavailable': 'newSession.provider.modelUnavailable',
    'provider-effort-unavailable': 'newSession.provider.effortUnavailable',
    'provider-mode-unavailable': 'newSession.provider.modeUnavailable',
    'provider-resume-unavailable': 'newSession.provider.resumeUnavailable'
}

export function formatProviderIssue(
    issue: ProviderReadinessIssue,
    agentLabel: string,
    t: Translate
): string {
    const message = t(PROVIDER_ISSUE_KEYS[issue.code], { agent: agentLabel })
    return issue.recoveryCommand
        ? `${message} ${t('newSession.provider.recovery', { command: issue.recoveryCommand })}`
        : message
}
