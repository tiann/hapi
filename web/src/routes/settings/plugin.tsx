import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { usePlugin } from '@/hooks/queries/usePlugin'
import { usePlugins } from '@/hooks/queries/usePlugins'
import { usePluginCapabilities } from '@/hooks/queries/usePluginCapabilities'
import { useMachines } from '@/hooks/queries/useMachines'
import { usePluginActions } from '@/hooks/mutations/usePluginActions'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { PluginDescriptorPanels, type DescriptorActionHandler, type DescriptorOptionSources } from '@/components/plugins/DescriptorRenderer'
import {
    localizedCapabilityDescription,
    localizedCapabilityName,
    localizedContributionName,
    localizedPluginDescription,
    localizedPluginName,
    pluginFeatureIntroMarkdown
} from '@/lib/plugin-metadata'
import { PluginTargetScopeSchema, type PluginCapabilityView, type PluginDetail, type PluginReloadResult, type PluginTargetScope } from '@hapi/protocol/plugins/admin'
import { preferredPluginDetailTarget } from './plugins'

type BadgeVariant = 'default' | 'warning' | 'success' | 'destructive'
type ResultState = {
    title: string
    lines: string[]
    tone: 'success' | 'warning' | 'error'
} | null

function BackIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
}

function PuzzleIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.4 13.5a1.9 1.9 0 1 0 0-3.8H17V7.3A2.3 2.3 0 0 0 14.7 5h-2.4a1.9 1.9 0 1 0-3.8 0H6.3A2.3 2.3 0 0 0 4 7.3v2.2a1.9 1.9 0 1 1 0 3.8v2.4A2.3 2.3 0 0 0 6.3 18h2.2a1.9 1.9 0 1 0 3.8 0h2.4a2.3 2.3 0 0 0 2.3-2.3v-2.2z" /></svg>
}

function ActivityIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
}

function FolderIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" /></svg>
}

function AlertIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
}

function statusVariant(status: string): BadgeVariant {
    if (['active', 'enabled', 'validated'].includes(status)) return 'success'
    if (['degraded', 'incompatible', 'blocked'].includes(status)) return 'warning'
    if (['failed', 'reload-failed', 'invalid'].includes(status)) return 'destructive'
    return 'default'
}

function severityVariant(severity: string): BadgeVariant {
    if (severity === 'error') return 'destructive'
    if (severity === 'warning') return 'warning'
    return 'default'
}

function sourceLabel(t: (key: string) => string, source: string): string {
    return t(`settings.plugins.source.${source}`)
}

function pluginTargetLabel(t: (key: string, params?: Record<string, string | number>) => string, plugin: PluginDetail): string {
    if (!plugin.target) return t('settings.plugins.target.local')
    if (plugin.target.scope === 'hub') return t('settings.plugins.target.hub')
    if (plugin.target.runtime === 'runner') return t('settings.plugins.target.runner', { name: plugin.target.displayName ?? plugin.target.machineId ?? plugin.target.scope })
    return plugin.target.scope
}

function targetScopeLabel(t: (key: string, params?: Record<string, string | number>) => string, scope?: string): string {
    if (!scope) return t('settings.plugins.target.local')
    if (scope === 'hub') return t('settings.plugins.target.hub')
    if (scope === 'all-runners') return t('settings.plugins.target.allRunners')
    if (scope.startsWith('runner:')) return t('settings.plugins.target.runner', { name: scope.slice('runner:'.length) })
    return scope
}

function webContributionsHaveComponent(contributions: unknown, kind: string): boolean {
    if (!contributions || typeof contributions !== 'object') return false
    const panels = (contributions as { settingsPanels?: unknown }).settingsPanels
    if (!Array.isArray(panels)) return false
    return panels.some((panel) => {
        if (!panel || typeof panel !== 'object') return false
        const components = (panel as { components?: unknown }).components
        return Array.isArray(components) && components.some((component) => (
            Boolean(component && typeof component === 'object' && (component as { kind?: unknown }).kind === kind)
        ))
    })
}

function runtimeActive(plugin: PluginDetail, runtime: string): boolean {
    if (runtime === 'hub') return plugin.runtimes.hub?.active === true
    if (runtime === 'runner') return plugin.runtimes.runner?.active === true
    return false
}

function Chip(props: { icon?: ReactNode; label: string; variant?: BadgeVariant }) {
    return <Badge variant={props.variant ?? 'default'} className="gap-1 font-medium">{props.icon}{props.label}</Badge>
}

function contributionId(entry: unknown): string | undefined {
    if (!entry || typeof entry !== 'object') return undefined
    const id = (entry as { id?: unknown }).id
    return typeof id === 'string' ? id : undefined
}

function contributionDisplay(entry: unknown): unknown {
    if (!entry || typeof entry !== 'object') return undefined
    const display = (entry as { display?: unknown }).display
    return display && typeof display === 'object' ? display : undefined
}

function contributionFallback(entry: unknown): unknown {
    if (!entry || typeof entry !== 'object') return undefined
    const descriptor = entry as { displayName?: unknown; title?: unknown; label?: unknown; id?: unknown }
    return descriptor.displayName ?? descriptor.title ?? descriptor.label ?? descriptor.id
}

function contributionName(t: (key: string) => string, locale: 'en' | 'zh-CN', pluginId: string, entry: unknown): string {
    if (!entry || typeof entry !== 'object') return t('settings.plugins.unknown')
    return localizedContributionName({
        pluginId,
        contributionId: contributionId(entry),
        display: contributionDisplay(entry),
        fallback: contributionFallback(entry),
        locale,
        unknownLabel: t('settings.plugins.unknown')
    })
}

function contributionSupportSuffix(t: (key: string) => string, entry: unknown): string {
    if (!entry || typeof entry !== 'object') return ''
    const supportStatus = (entry as { supportStatus?: unknown }).supportStatus
    return typeof supportStatus === 'string' ? ` · ${t(`settings.plugins.supportStatus.${supportStatus}`)}` : ''
}

function contributionExperimentalSuffix(t: (key: string) => string): string {
    return ` · ${t('settings.plugins.contribution.experimental')}`
}

function formatConfig(value: unknown): string {
    return JSON.stringify(value ?? {}, null, 2)
}

function parseConfig(text: string, t: (key: string, params?: Record<string, string | number>) => string): Record<string, unknown> {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('settings.plugins.config.mustBeObject'))
    }
    const redactedPath = findRedactedPlaceholderPath(parsed)
    if (redactedPath) {
        throw new Error(t('settings.plugins.config.redactedPlaceholder', { path: redactedPath }))
    }
    return parsed as Record<string, unknown>
}

function findRedactedPlaceholderPath(value: unknown, path = '$'): string | null {
    if (value === '[REDACTED]') {
        return path
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = findRedactedPlaceholderPath(value[index], `${path}[${index}]`)
            if (found) return found
        }
        return null
    }
    if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const found = findRedactedPlaceholderPath(entry, `${path}.${key}`)
            if (found) return found
        }
    }
    return null
}

function reloadLines(t: (key: string, params?: Record<string, string | number>) => string, result: PluginReloadResult): string[] {
    if (result.results.length === 0) {
        return [t('settings.plugins.reloadResult.noChanges')]
    }
    return result.results.map((item) => `${item.id}: ${t(`settings.plugins.action.${item.action}`)} · ${t(`settings.plugins.status.${item.status}`)}${item.message ? ` — ${item.message}` : ''}`)
}

function ResultCard(props: { result: ResultState; onDismiss: () => void }) {
    if (!props.result) return null
    const toneClass = props.result.tone === 'error'
        ? 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
        : props.result.tone === 'warning'
            ? 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
            : 'border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
    return (
        <div className={`rounded-xl border p-3 text-sm ${toneClass}`}>
            <div className="mb-1 flex items-center justify-between gap-3 font-medium">
                <span>{props.result.title}</span>
                <button type="button" className="text-xs opacity-80" onClick={props.onDismiss}>×</button>
            </div>
            <ul className="space-y-1">
                {props.result.lines.map((line, index) => <li key={`${line}-${index}`} className="break-all">{line}</li>)}
            </ul>
        </div>
    )
}

function SectionCard(props: { title: string; children: ReactNode }) {
    return (
        <Card className="border border-[var(--app-border)] bg-[var(--app-bg)]">
            <CardContent className="space-y-3 p-3">
                <div className="text-sm font-semibold">{props.title}</div>
                {props.children}
            </CardContent>
        </Card>
    )
}

function KeyValue(props: { label: string; value: ReactNode }) {
    return (
        <div className="grid gap-1 rounded-lg bg-[var(--app-subtle-bg)] p-2 text-sm sm:grid-cols-[8rem_1fr]">
            <div className="font-medium text-[var(--app-hint)]">{props.label}</div>
            <div className="min-w-0 break-all">{props.value}</div>
        </div>
    )
}

function DiagnosticsList(props: { plugin: PluginDetail; t: (key: string, params?: Record<string, string | number>) => string }) {
    const { plugin, t } = props
    if (plugin.diagnostics.length === 0) {
        return <div className="rounded-lg bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">{t('settings.plugins.diagnostics.empty')}</div>
    }
    return (
        <div className="space-y-2">
            {plugin.diagnostics.map((diagnostic, index) => (
                <div key={`${diagnostic.code}-${index}`} className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant={severityVariant(diagnostic.severity)}>{t(`settings.plugins.diagnosticSeverity.${diagnostic.severity}`)}</Badge>
                        <span className="font-mono text-xs">{diagnostic.code}</span>
                    </div>
                    <div>{diagnostic.message}</div>
                    {diagnostic.target?.scope || diagnostic.configScope ? (
                        <div className="mt-1 break-all text-xs text-[var(--app-hint)]">
                            {diagnostic.target?.scope ? `${t('settings.plugins.detail.targetLabel')}: ${diagnostic.target.scope}` : null}
                            {diagnostic.target?.scope && diagnostic.configScope ? ' · ' : null}
                            {diagnostic.configScope ? `${t('settings.plugins.config.scopeLabel')}: ${diagnostic.configScope}` : null}
                        </div>
                    ) : null}
                    {diagnostic.path ? <div className="mt-1 break-all text-xs text-[var(--app-hint)]">{diagnostic.path}</div> : null}
                </div>
            ))}
        </div>
    )
}

function capabilityStatusVariant(status: string): BadgeVariant {
    if (status === 'ready') return 'success'
    if (['partial', 'missing-target', 'offline', 'disabled'].includes(status)) return 'warning'
    if (['failed', 'incompatible'].includes(status)) return 'destructive'
    return 'default'
}

function capabilityPartLabel(t: (key: string) => string, part: 'web' | 'hub' | 'runner'): string {
    return t(`settings.plugins.capabilityPart.${part}`)
}

function CapabilitiesList(props: {
    capabilities: PluginCapabilityView[]
    loading: boolean
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    const { capabilities, loading, t, locale } = props
    if (loading && capabilities.length === 0) {
        return <LoadingState label={t('settings.plugins.capabilities.loading')} className="p-2" />
    }
    if (capabilities.length === 0) {
        return <div className="rounded-lg bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">{t('settings.plugins.capabilities.empty')}</div>
    }
    return (
        <div className="space-y-2">
            {capabilities.map((capability) => (
                <div key={`${capability.pluginId}-${capability.capabilityId}`} className="rounded-lg border border-[var(--app-border)] p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="font-medium">{localizedCapabilityName(capability, locale)}</div>
                            <div className="break-all text-xs text-[var(--app-hint)]">{t(`settings.plugins.capabilityKind.${capability.kind}`)} · {capability.capabilityId}</div>
                            {localizedCapabilityDescription(capability, locale) ? <div className="mt-1 text-sm text-[var(--app-hint)]">{localizedCapabilityDescription(capability, locale)}</div> : null}
                        </div>
                        <Badge variant={capabilityStatusVariant(capability.status)}>{t(`settings.plugins.capabilityStatus.${capability.status}`)}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        {(['web', 'hub', 'runner'] as const).map((partName) => {
                            const part = capability.parts[partName]
                            if (!part) return null
                            const suffix = part.target?.scope ? ` · ${targetScopeLabel(t, part.target.scope)}` : ''
                            return (
                                <Chip
                                    key={partName}
                                    label={`${capabilityPartLabel(t, partName)} · ${t(`settings.plugins.capabilityStatus.${part.status}`)}${suffix}`}
                                    variant={capabilityStatusVariant(part.status)}
                                />
                            )
                        })}
                    </div>
                    {capability.diagnostics.length > 0 ? (
                        <div className="mt-2 text-xs text-[var(--app-hint)]">
                            {capability.diagnostics.slice(0, 2).map((diagnostic) => diagnostic.message).join(' · ')}
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    )
}

function ContributionsList(props: { plugin: PluginDetail; t: (key: string, params?: Record<string, string | number>) => string; locale: 'en' | 'zh-CN' }) {
    const { plugin, t, locale } = props
    const chips: Array<{ key: string; label: string; variant?: BadgeVariant }> = [
        ...plugin.contributions.notificationChannels.map((channel) => ({
            key: `hub-notification-${channel.id}`,
            label: `${t('settings.plugins.contribution.hubNotification')} · ${contributionName(t, locale, plugin.id, channel)} · ${channel.id}`,
            variant: 'success' as BadgeVariant
        })),
        ...(plugin.contributions.runner?.environmentProviders ?? []).map((entry) => ({
            key: `runner-env-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.runnerEnv')} · ${contributionName(t, locale, plugin.id, entry)}`,
            variant: 'success' as BadgeVariant
        })),
        ...(plugin.contributions.runner?.commandResolvers ?? []).map((entry) => ({
            key: `runner-command-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.runnerCommand')} · ${contributionName(t, locale, plugin.id, entry)}`,
            variant: 'success' as BadgeVariant
        })),
        ...(plugin.contributions.runner?.spawnHooks ?? []).map((entry) => ({
            key: `runner-spawn-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.runnerSpawn')} · ${contributionName(t, locale, plugin.id, entry)}`,
            variant: 'success' as BadgeVariant
        })),
        ...(plugin.contributions.agent?.adapters ?? []).map((entry) => ({
            key: `agent-adapter-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.agentAdapter')} · ${contributionName(t, locale, plugin.id, entry)}`
        })),
        ...(plugin.contributions.agent?.capabilityProviders ?? []).map((entry) => ({
            key: `agent-capability-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.agentCapability')} · ${contributionName(t, locale, plugin.id, entry)}`
        })),
        ...(plugin.contributions.voice?.providers ?? []).map((entry) => ({
            key: `voice-provider-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.voiceProvider')} · ${contributionName(t, locale, plugin.id, entry)}${contributionSupportSuffix(t, entry)}${contributionExperimentalSuffix(t)}`,
            variant: 'warning' as BadgeVariant
        })),
        ...(plugin.contributions.deployment?.packs ?? []).map((entry) => ({
            key: `deployment-pack-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.deploymentPack')} · ${contributionName(t, locale, plugin.id, entry)}${contributionSupportSuffix(t, entry)}${contributionExperimentalSuffix(t)}`,
            variant: 'warning' as BadgeVariant
        })),
        ...(plugin.contributions.integration?.protocolBridges ?? []).map((entry) => ({
            key: `integration-protocol-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.protocolBridge')} · ${contributionName(t, locale, plugin.id, entry)}${contributionSupportSuffix(t, entry)}${contributionExperimentalSuffix(t)}`,
            variant: 'warning' as BadgeVariant
        })),
        ...(plugin.contributions.web?.settingsPanels ?? []).map((entry) => ({
            key: `web-settings-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.webSettings')} · ${contributionName(t, locale, plugin.id, entry)}`
        })),
        ...(plugin.contributions.web?.newSessionFields ?? []).map((entry) => ({
            key: `web-new-session-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.webNewSession')} · ${contributionName(t, locale, plugin.id, entry)}`
        })),
        ...(plugin.contributions.web?.actions ?? []).map((entry) => ({
            key: `web-action-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.webAction')} · ${contributionName(t, locale, plugin.id, entry)}${contributionExperimentalSuffix(t)}`,
            variant: 'warning' as BadgeVariant
        })),
        ...(plugin.contributions.web?.badges ?? []).map((entry) => ({
            key: `web-badge-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.webBadge')} · ${contributionName(t, locale, plugin.id, entry)}${contributionExperimentalSuffix(t)}`,
            variant: 'warning' as BadgeVariant
        })),
        ...(plugin.contributions.web?.composerActions ?? []).map((entry) => ({
            key: `web-composer-action-${String((entry as { id?: unknown }).id)}`,
            label: `${t('settings.plugins.contribution.webComposerAction')} · ${contributionName(t, locale, plugin.id, entry)}`
        }))
    ]

    if (chips.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.detail.noContributions')}</div>
    }

    return (
        <div className="flex flex-wrap gap-2">
            {chips.map((chip) => <Chip key={chip.key} icon={<ActivityIcon />} label={chip.label} variant={chip.variant} />)}
        </div>
    )
}

function secretPermissionLabel(
    t: (key: string, params?: Record<string, string | number>) => string,
    secret: PluginDetail['permissions']['secrets'][number]
): string {
    const parts = [
        `${secret.name}: ${secret.present ? t('settings.plugins.secret.present') : t('settings.plugins.secret.missing')}`,
        secret.required === false ? t('settings.plugins.permissions.optional') : t('settings.plugins.permissions.required')
    ]
    if (secret.lastChecked) {
        parts.push(t('settings.plugins.permissions.checkedAt', { date: new Date(secret.lastChecked).toLocaleString() }))
    }
    return parts.join(' · ')
}

function DeveloperDetails(props: {
    plugin: PluginDetail
    capabilities: PluginCapabilityView[]
    capabilitiesLoading: boolean
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    const { plugin, capabilities, capabilitiesLoading, t, locale } = props
    return (
        <details className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm">
            <summary className="cursor-pointer font-medium">{t('settings.plugins.detail.developerDetails')}</summary>
            <div className="mt-3 space-y-4">
                <div className="space-y-2">
                    <KeyValue label={t('settings.plugins.detail.idLabel')} value={plugin.id} />
                    <KeyValue label={t('settings.plugins.detail.targetLabel')} value={pluginTargetLabel(t, plugin)} />
                    <KeyValue label={t('settings.plugins.detail.sourceLabel')} value={sourceLabel(t, plugin.source)} />
                    <KeyValue label={t('settings.plugins.detail.rootLabel')} value={plugin.rootPath} />
                    <KeyValue label={t('settings.plugins.detail.manifestLabel')} value={plugin.manifestPath} />
                </div>

                {plugin.diagnostics.length > 0 ? (
                    <div className="space-y-2">
                        <div className="font-medium">{t('settings.plugins.diagnostics.title')}</div>
                        <DiagnosticsList plugin={plugin} t={t} />
                    </div>
                ) : null}

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.detail.runtime')}</div>
                    {plugin.runtimeEntryPaths.length === 0 ? <div className="text-sm text-[var(--app-hint)]">{t('settings.plugins.none')}</div> : plugin.runtimeEntryPaths.map((entry) => (
                        <div key={`${entry.runtime}-${entry.realPath}`} className="rounded-lg border border-[var(--app-border)] p-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <Badge>{t(`settings.plugins.runtime.${entry.runtime}`)}</Badge>
                                <Badge variant={runtimeActive(plugin, entry.runtime) ? 'success' : 'default'}>{runtimeActive(plugin, entry.runtime) ? t('settings.plugins.state.active') : t('settings.plugins.state.inactive')}</Badge>
                            </div>
                            <KeyValue label={entry.runtime === 'runner' ? t('settings.plugins.detail.runnerEntryLabel') : t('settings.plugins.detail.hubEntryLabel')} value={entry.entry} />
                            <div className="mt-2"><KeyValue label={t('settings.plugins.detail.resolvedPathLabel')} value={entry.resolvedPath} /></div>
                            <div className="mt-2"><KeyValue label={t('settings.plugins.detail.realPathLabel')} value={entry.realPath} /></div>
                        </div>
                    ))}
                </div>

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.detail.contributions')}</div>
                    <ContributionsList plugin={plugin} t={t} locale={locale} />
                </div>

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.capabilities.title')}</div>
                    <CapabilitiesList capabilities={capabilities} loading={capabilitiesLoading} t={t} locale={locale} />
                </div>

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.detail.permissions')}</div>
                    <div className="rounded-lg bg-[var(--app-subtle-bg)] p-2 text-xs text-[var(--app-hint)]">{t('settings.plugins.detail.permissionsDescription')}</div>
                    <div>
                        <div className="mb-1 font-medium text-[var(--app-hint)]">{t('settings.plugins.detail.networkLabel')} · {targetScopeLabel(t, plugin.target?.scope)}</div>
                        {plugin.permissions.network.length === 0 ? <div className="text-[var(--app-hint)]">{t('settings.plugins.permissions.networkEmpty')}</div> : <div className="flex flex-wrap gap-2">{plugin.permissions.network.map((entry) => <Chip key={entry} label={entry} variant="warning" />)}</div>}
                    </div>
                    <div>
                        <div className="mb-1 font-medium text-[var(--app-hint)]">{t('settings.plugins.detail.secretsLabel')} · {targetScopeLabel(t, plugin.target?.scope)}</div>
                        {plugin.permissions.secrets.length === 0 ? <div className="text-[var(--app-hint)]">{t('settings.plugins.permissions.secretsEmpty')}</div> : (
                            <div className="flex flex-wrap gap-2">
                                {plugin.permissions.secrets.map((secret) => <Chip key={`${secret.configScope ?? plugin.target?.scope ?? 'local'}-${secret.name}`} label={secretPermissionLabel(t, secret)} variant={secret.present ? 'success' : 'warning'} />)}
                            </div>
                        )}
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.config.title')}</div>
                    <div className="space-y-1 rounded-lg bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                        <div>{t('settings.plugins.config.scopeLabel')}: {plugin.configMetadata?.scope ?? plugin.configScope ?? targetScopeLabel(t)}</div>
                        <div>{t('settings.plugins.detail.targetLabel')}: {plugin.configMetadata?.target.scope ?? plugin.target?.scope ?? targetScopeLabel(t)}</div>
                        <div>{t('settings.plugins.config.sourceLabel')}: {plugin.configMetadata?.source ? t(`settings.plugins.config.source.${plugin.configMetadata.source}`) : t('settings.plugins.none')}</div>
                        {plugin.configMetadata?.updatedAt ? <div>{t('settings.plugins.config.updatedLabel')}: {new Date(plugin.configMetadata.updatedAt).toLocaleString()}</div> : null}
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--app-subtle-bg)] p-3 text-xs">{JSON.stringify(plugin.config ?? {}, null, 2)}</pre>
                </div>

                <div className="space-y-2">
                    <div className="font-medium">{t('settings.plugins.detail.manifestLabel')}</div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--app-subtle-bg)] p-3 text-xs">{JSON.stringify(plugin.manifest ?? {}, null, 2)}</pre>
                </div>
            </div>
        </details>
    )
}

export default function PluginPage() {
    const { pluginId } = useParams({ from: '/settings/plugins/$pluginId' })
    const search = useSearch({ from: '/settings/plugins/$pluginId' })
    const requestedTarget = PluginTargetScopeSchema.safeParse(search.target).success ? search.target as PluginTargetScope : undefined
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { t, locale } = useTranslation()
    const pluginListState = usePlugins(api)
    const target = useMemo(
        () => preferredPluginDetailTarget(pluginListState.plugins, pluginId, requestedTarget),
        [pluginListState.plugins, pluginId, requestedTarget]
    )
    const { plugin, isLoading, error } = usePlugin(api, pluginId, target)
    const capabilityState = usePluginCapabilities(api, { target })
    const actions = usePluginActions(api)
    const needsRunnerDescriptorContext = webContributionsHaveComponent(plugin?.contributions.web, 'runnerSpawnDefaultsEditor')
    const machineState = useMachines(api, needsRunnerDescriptorContext)
    const [configText, setConfigText] = useState('{}')
    const [initialConfigText, setInitialConfigText] = useState('{}')
    const [result, setResult] = useState<ResultState>(null)
    const [configError, setConfigError] = useState<string | null>(null)
    const [enableDialogOpen, setEnableDialogOpen] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [descriptorOptionSources, setDescriptorOptionSources] = useState<DescriptorOptionSources | undefined>(undefined)

    useEffect(() => {
        const next = formatConfig(plugin?.config ?? {})
        setConfigText(next)
        setInitialConfigText(next)
        setConfigError(null)
    }, [plugin])

    useEffect(() => {
        if (!target || target === requestedTarget) return
        navigate({
            to: '/settings/plugins/$pluginId',
            params: { pluginId },
            search: { target },
            replace: true
        })
    }, [navigate, pluginId, requestedTarget, target])

    useEffect(() => {
        let cancelled = false
        void api.getPluginNotificationFilterOptions()
            .then((options) => {
                if (cancelled) return
                setDescriptorOptionSources({
                    'notification.namespaces': options.namespaces,
                    'notification.agents': options.agents,
                    'notification.workspaces': options.workspaces,
                    'sessions.agents': options.agents,
                    'sessions.workspaces': options.workspaces
                })
            })
            .catch(() => {
                if (!cancelled) {
                    setDescriptorOptionSources({
                        'notification.namespaces': [],
                        'notification.agents': [],
                        'notification.workspaces': [],
                        'sessions.agents': [],
                        'sessions.workspaces': []
                    })
                }
            })
        return () => {
            cancelled = true
        }
    }, [api])

    const dirtyConfig = configText !== initialConfigText
    const issueCount = useMemo(() => plugin?.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length ?? 0, [plugin])
    const canEnablePlugin = plugin ? !['invalid', 'incompatible', 'blocked'].includes(plugin.status) : false
    const canDeletePlugin = plugin?.source === 'user-home'
    const hasConfig = Boolean(plugin && (Object.keys(plugin.config ?? {}).length > 0 || dirtyConfig))
    const runnerTargetMachineId = plugin?.target?.machineId
        ?? (typeof target === 'string' && target.startsWith('runner:') ? target.slice('runner:'.length) : null)
    const mergedDescriptorOptionSources = useMemo((): DescriptorOptionSources | undefined => {
        if (!descriptorOptionSources && machineState.machines.length === 0) return descriptorOptionSources
        const runnerAgents = machineState.machines.flatMap((machine) => (
            (machine.runnerState?.agentDescriptors ?? []).map((descriptor) => ({
                value: descriptor.id,
                label: descriptor.displayName || descriptor.id,
                ...(descriptor.description ? { description: descriptor.description } : {})
            }))
        ))
        const runnerWorkspaces = machineState.machines.flatMap((machine) => (
            (machine.metadata?.workspaceRoots ?? []).map((path) => ({ value: path, label: path }))
        ))
        return {
            ...(descriptorOptionSources ?? {}),
            ...(runnerAgents.length > 0 ? { 'runner.agents': runnerAgents } : {}),
            ...(runnerWorkspaces.length > 0 ? { 'runner.workspaces': runnerWorkspaces } : {})
        }
    }, [descriptorOptionSources, machineState.machines])
    const pluginCapabilities = useMemo(
        () => capabilityState.capabilities.filter((capability) => capability.pluginId === plugin?.id),
        [capabilityState.capabilities, plugin?.id]
    )
    const descriptorConfig = useMemo(() => {
        try {
            return parseConfig(configText, t)
        } catch {
            return plugin?.config ?? {}
        }
    }, [configText, plugin?.config, t])
    const featureIntro = useMemo(
        () => plugin ? pluginFeatureIntroMarkdown(plugin, locale) : '',
        [plugin, locale]
    )

    const showReloadResult = (title: string, reloadResult: PluginReloadResult) => {
        setResult({
            title,
            tone: reloadResult.ok ? 'success' : 'warning',
            lines: reloadLines(t, reloadResult)
        })
    }

    const runAction = async (title: string, work: () => Promise<PluginReloadResult>): Promise<boolean> => {
        try {
            showReloadResult(title, await work())
            return true
        } catch (err) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [err instanceof Error ? err.message : String(err)] })
            return false
        }
    }

    const enable = async () => {
        if (!plugin) return
        showReloadResult(t('settings.plugins.action.enable'), await actions.enablePlugin(plugin.id, undefined, target))
    }

    const disable = async () => {
        if (!plugin) return
        await runAction(t('settings.plugins.action.disable'), async () => await actions.disablePlugin(plugin.id, target))
    }

    const reload = async () => {
        if (!plugin) return
        await runAction(t('settings.plugins.action.reload'), async () => await actions.reloadPlugin(plugin.id, target))
    }

    const primaryReloadAction = async () => {
        if (!plugin) return
        if (dirtyConfig) {
            await saveConfig()
            return
        }
        await reload()
    }

    const deletePlugin = async () => {
        if (!plugin) return
        await actions.deletePlugin(plugin.id, target)
        navigate({ to: '/settings/plugins', replace: true })
    }

    const saveConfigObject = async (config: Record<string, unknown>): Promise<void> => {
        if (!plugin) return
        setConfigError(null)
        const saved = await runAction(t('settings.plugins.action.configSaved'), async () => await actions.saveConfig(plugin.id, config, target))
        if (!saved) {
            throw new Error(t('settings.plugins.error.title'))
        }
        const formatted = formatConfig(config)
        setConfigText(formatted)
        setInitialConfigText(formatted)
    }

    const draftConfigObject = (config: Record<string, unknown>): void => {
        setConfigText(formatConfig(config))
        setConfigError(null)
    }

    const saveConfig = async () => {
        if (!plugin) return
        try {
            await saveConfigObject(parseConfig(configText, t))
        } catch (err) {
            setConfigError(err instanceof Error ? err.message : t('settings.plugins.config.invalidJson'))
        }
    }

    const runDescriptorAction: DescriptorActionHandler = async (actionId) => {
        if (!plugin) return
        if (actionId === 'plugin.notificationTest') {
            if (dirtyConfig) {
                setResult({
                    title: t('settings.plugins.action.notificationTest'),
                    tone: 'warning',
                    lines: [t('settings.plugins.action.notificationTestUnsaved')]
                })
                return
            }
            try {
                const response = await actions.testPluginNotification(plugin.id, target)
                setResult({
                    title: t('settings.plugins.action.notificationTestSent'),
                    tone: 'success',
                    lines: [response.message ?? t('settings.plugins.action.notificationTestResult', { count: response.channels })]
                })
            } catch (err) {
                setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [err instanceof Error ? err.message : String(err)] })
            }
            return
        }
        if (actionId === 'plugin.enable') {
            setEnableDialogOpen(true)
            return
        }
        if (actionId === 'plugin.disable') {
            await disable()
            return
        }
        if (actionId === 'plugin.reload') {
            await reload()
            return
        }
        if (actionId === 'plugin.delete') {
            setDeleteDialogOpen(true)
        }
    }

    const formatConfigText = () => {
        try {
            const parsed = parseConfig(configText, t)
            setConfigText(formatConfig(parsed))
            setConfigError(null)
        } catch (err) {
            setConfigError(err instanceof Error ? err.message : t('settings.plugins.config.invalidJson'))
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <Button type="button" variant="secondary" size="sm" onClick={goBack} className="h-8 w-8 rounded-full p-0"><BackIcon /></Button>
                    <div className="min-w-0 flex-1">
                        <div className="font-semibold">{t('settings.plugins.detail.title')}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{pluginId}</div>
                    </div>
                    {plugin ? (
                        <Button type="button" variant="outline" size="sm" disabled={actions.isPending} onClick={() => void primaryReloadAction()}>
                            {actions.isPending
                                ? t('settings.plugins.config.saving')
                                : dirtyConfig
                                    ? t('settings.plugins.config.saveAndReload')
                                    : t('settings.plugins.action.reload')}
                        </Button>
                    ) : null}
                </div>
            </div>
            <div className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-content space-y-3 p-3">
                    {isLoading ? <LoadingState label={t('settings.plugins.detail.loading')} className="p-2" /> : null}
                    {error ? <div className="rounded-xl border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{error}</div> : null}
                    <ResultCard result={result} onDismiss={() => setResult(null)} />
                    {plugin ? (
                        <>
                            <Card className="overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg)]">
                                <div className="bg-gradient-to-br from-[var(--app-secondary-bg)] to-[var(--app-bg)] p-4">
                                    <div className="flex gap-3">
                                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--app-bg)] text-[var(--app-link)] shadow-sm"><PuzzleIcon /></div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h2 className="truncate text-xl font-semibold">{localizedPluginName(plugin, locale)}</h2>
                                                <Badge variant={statusVariant(plugin.status)}>{t(`settings.plugins.status.${plugin.status}`)}</Badge>
                                            </div>
                                            <div className="mt-1 text-sm text-[var(--app-hint)]">{t('settings.plugins.detail.meta', { id: plugin.id, version: plugin.version ?? t('settings.plugins.unknown'), status: t(`settings.plugins.status.${plugin.status}`) })}</div>
                                            {localizedPluginDescription(plugin, locale) ? <p className="mt-2 text-sm text-[var(--app-hint)]">{localizedPluginDescription(plugin, locale)}</p> : null}
                                            <div className="mt-3 flex flex-wrap gap-1.5">
                                                <Chip label={pluginTargetLabel(t, plugin)} variant={plugin.target?.active === false ? 'warning' : 'default'} />
                                                {plugin.target?.stale ? <Chip label={t('settings.plugins.target.stale')} variant="warning" /> : null}
                                                <Chip icon={<FolderIcon />} label={sourceLabel(t, plugin.source)} />
                                                {issueCount > 0 ? <Chip icon={<AlertIcon />} label={t('settings.plugins.list.diagnostics', { count: issueCount })} variant="warning" /> : null}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </Card>

                            {featureIntro ? (
                                <SectionCard title={t('settings.plugins.detail.featureIntro.title')}>
                                    <MarkdownRenderer content={featureIntro} className="text-sm" />
                                </SectionCard>
                            ) : null}

                            <SectionCard title={t('settings.plugins.detail.actions')}>
                                <div className="flex flex-wrap gap-2">
                                    {plugin.enabled ? (
                                        <Button type="button" variant="destructive" disabled={actions.isPending} onClick={() => void disable()}>{t('settings.plugins.action.disable')}</Button>
                                    ) : (
                                        <Button type="button" disabled={actions.isPending || !canEnablePlugin} onClick={() => setEnableDialogOpen(true)}>{t('settings.plugins.action.enable')}</Button>
                                    )}
                                    <Button type="button" variant="destructive" disabled={actions.isPending || !canDeletePlugin} onClick={() => setDeleteDialogOpen(true)}>{t('settings.plugins.action.delete')}</Button>
                                </div>
                                {!plugin.enabled && !canEnablePlugin ? <div className="mt-2 text-sm text-[var(--app-hint)]">{t('settings.plugins.action.cannotEnableStatus', { status: t(`settings.plugins.status.${plugin.status}`) })}</div> : null}
                            </SectionCard>

                            {plugin.contributions.web?.settingsPanels?.length ? (
                                <PluginDescriptorPanels
                                    contributions={plugin.contributions.web}
                                    config={descriptorConfig}
                                    disabled={actions.isPending || (needsRunnerDescriptorContext && machineState.isLoading)}
                                    optionSources={mergedDescriptorOptionSources}
                                    onAction={runDescriptorAction}
                                    onConfigChange={draftConfigObject}
                                    machines={machineState.machines}
                                    targetMachineId={runnerTargetMachineId}
                                    dirty={dirtyConfig}
                                />
                            ) : null}

                            {hasConfig ? <SectionCard title={t('settings.plugins.config.title')}>
                                <div className="space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <label className="text-sm font-medium" htmlFor="plugin-config-json">{t('settings.plugins.config.textareaLabel')}</label>
                                        {dirtyConfig ? <Badge variant="warning">{t('settings.plugins.config.unsaved')}</Badge> : <Badge variant="success">{t('settings.plugins.config.saved')}</Badge>}
                                    </div>
                                    <textarea
                                        id="plugin-config-json"
                                        value={configText}
                                        onChange={(event) => setConfigText(event.target.value)}
                                        className="min-h-48 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 font-mono text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)]"
                                    />
                                    {configError ? <div className="text-sm text-red-600">{configError}</div> : null}
                                    <div className="flex flex-wrap gap-2">
                                        <Button type="button" variant="outline" onClick={formatConfigText}>{t('settings.plugins.config.format')}</Button>
                                        <Button type="button" variant="outline" disabled={!dirtyConfig} onClick={() => { setConfigText(initialConfigText); setConfigError(null) }}>{t('settings.plugins.config.reset')}</Button>
                                    </div>
                                </div>
                            </SectionCard> : null}

                            <DeveloperDetails
                                plugin={plugin}
                                capabilities={pluginCapabilities}
                                capabilitiesLoading={capabilityState.isLoading}
                                t={t}
                                locale={locale}
                            />

                            <ConfirmDialog
                                isOpen={enableDialogOpen}
                                onClose={() => setEnableDialogOpen(false)}
                                title={t('settings.plugins.confirm.enable.title')}
                                description={t('settings.plugins.confirm.enable.description', { target: pluginTargetLabel(t, plugin) })}
                                confirmLabel={t('settings.plugins.confirm.enable.confirm')}
                                confirmingLabel={t('settings.plugins.confirm.enable.confirming')}
                                onConfirm={enable}
                                isPending={actions.isPending}
                            />
                            <ConfirmDialog
                                isOpen={deleteDialogOpen}
                                onClose={() => setDeleteDialogOpen(false)}
                                title={t('settings.plugins.confirm.delete.title')}
                                description={t('settings.plugins.confirm.delete.description', { id: plugin.id, path: plugin.rootPath })}
                                confirmLabel={t('settings.plugins.confirm.delete.confirm')}
                                confirmingLabel={t('settings.plugins.confirm.delete.confirming')}
                                onConfirm={deletePlugin}
                                isPending={actions.isPending}
                                destructive
                            />
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    )
}
