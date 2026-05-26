import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { usePlugins } from '@/hooks/queries/usePlugins'
import { usePluginMarketplace } from '@/hooks/queries/usePluginMarketplace'
import { usePluginActions } from '@/hooks/mutations/usePluginActions'
import { useTranslation } from '@/lib/use-translation'
import { localizedPluginDescription, localizedPluginName, localizedText } from '@/lib/plugin-metadata'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { LoadingState } from '@/components/LoadingState'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { PluginInstallPlanResponse, PluginInstallResult, PluginListItem, PluginReloadResult, PluginTargetScope } from '@hapi/protocol/plugins/admin'
import type { PluginMarketplaceEntryView, PluginMarketplaceInstallPlanResponse } from '@hapi/protocol/plugins/marketplace'
import { comparePluginVersions } from '@hapi/protocol/plugins/runtime/versioning'

type PluginFilter = 'all' | 'active' | 'enabled' | 'issues'
type PluginSettingsTab = 'installed' | 'marketplace'
type BadgeVariant = 'default' | 'warning' | 'success' | 'destructive'
type MarketplacePendingAction = 'check' | 'install'
export const DEFAULT_PLUGIN_SETTINGS_TAB = 'installed' satisfies PluginSettingsTab
export type PluginDisplayGroup = {
    id: string
    name?: string
    version?: string
    description?: string
    display?: PluginListItem['display']
    source: PluginListItem['source']
    status: PluginListItem['status']
    enabled: boolean
    active: boolean
    diagnostics: PluginListItem['diagnostics']
    plugins: PluginListItem[]
    primary: PluginListItem
}
type ResultState = {
    title: string
    lines: string[]
    tone: 'success' | 'warning' | 'error'
} | null
type ResultPayload = NonNullable<ResultState>
type MarketplacePlanState = {
    key: string
    response: PluginMarketplaceInstallPlanResponse
} | null
type MarketplaceInstallPlanKeyInput = {
    pluginId: string
    version?: string
    enable: boolean
    overwrite: boolean
    updateAvailable?: boolean
}

export function createMarketplaceInstallPlanKey(input: MarketplaceInstallPlanKeyInput): string {
    return JSON.stringify({
        pluginId: input.pluginId,
        version: input.version ?? '',
        enable: input.enable,
        overwrite: input.overwrite || input.updateAvailable === true,
        runnerSelectionMode: 'compatible'
    })
}

function BackIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
}

function PuzzleIcon() {
    return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.4 13.5a1.9 1.9 0 1 0 0-3.8H17V7.3A2.3 2.3 0 0 0 14.7 5h-2.4a1.9 1.9 0 1 0-3.8 0H6.3A2.3 2.3 0 0 0 4 7.3v2.2a1.9 1.9 0 1 1 0 3.8v2.4A2.3 2.3 0 0 0 6.3 18h2.2a1.9 1.9 0 1 0 3.8 0h2.4a2.3 2.3 0 0 0 2.3-2.3v-2.2z" /></svg>
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

function pluginHasIssue(plugin: PluginListItem): boolean {
    return plugin.diagnostics.some((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning') || ['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(plugin.status)
}

function pluginGroupHasIssue(group: PluginDisplayGroup): boolean {
    return group.diagnostics.some((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning') || ['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(group.status)
}

function sourceLabel(t: (key: string) => string, source: string): string {
    return t(`settings.plugins.source.${source}`)
}

function pluginTargetLabel(t: (key: string, params?: Record<string, string | number>) => string, plugin: PluginListItem): string {
    if (!plugin.target) return t('settings.plugins.target.local')
    if (plugin.target.scope === 'hub') return t('settings.plugins.target.hub')
    if (plugin.target.runtime === 'runner') return t('settings.plugins.target.runner', { name: plugin.target.displayName ?? plugin.target.machineId ?? plugin.target.scope })
    return plugin.target.scope
}

function targetLabel(t: (key: string, params?: Record<string, string | number>) => string, target: { scope: string; runtime: string; displayName?: string; machineId?: string }): string {
    if (target.scope === 'hub') return t('settings.plugins.target.hub')
    if (target.runtime === 'runner') return t('settings.plugins.target.runner', { name: target.displayName ?? target.machineId ?? target.scope })
    return target.scope
}

function Chip(props: { icon?: ReactNode; label: string; variant?: BadgeVariant }) {
    return <Badge variant={props.variant ?? 'default'} className="gap-1 font-medium">{props.icon}{props.label}</Badge>
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)))
}

function groupTargetLabel(t: (key: string, params?: Record<string, string | number>) => string, group: PluginDisplayGroup): string {
    const labels = uniqueStrings(group.plugins.map((plugin) => pluginTargetLabel(t, plugin)))
    if (labels.length <= 2) return labels.join(' + ')
    return t('settings.plugins.target.count', { count: labels.length })
}

function groupSourceLabel(t: (key: string) => string, group: PluginDisplayGroup): string {
    return uniqueStrings(group.plugins.map((plugin) => sourceLabel(t, plugin.source))).join(' + ')
}

function groupVersionLabel(t: (key: string) => string, group: PluginDisplayGroup): string {
    const versions = uniqueStrings(group.plugins.map((plugin) => plugin.version ?? ''))
    if (versions.length === 0) return t('settings.plugins.unknown')
    return versions.join(' + ')
}

function pluginMeta(t: (key: string, params?: Record<string, string | number>) => string, group: PluginDisplayGroup, issueCount: number): string {
    const parts = [
        groupVersionLabel(t, group),
        groupSourceLabel(t, group),
        groupTargetLabel(t, group)
    ]
    if (issueCount > 0) {
        parts.push(t('settings.plugins.list.diagnostics', { count: issueCount }))
    }
    return parts.join(' · ')
}

const PLUGIN_STATUS_RANK: Record<PluginListItem['status'], number> = {
    invalid: 100,
    failed: 95,
    'reload-failed': 94,
    blocked: 90,
    incompatible: 85,
    degraded: 80,
    active: 70,
    enabled: 60,
    validated: 50,
    discovered: 40,
    disabled: 10
}

function pluginStatusRank(status: PluginListItem['status']): number {
    return PLUGIN_STATUS_RANK[status] ?? 0
}

function isHubDescriptorMirror(plugin: PluginListItem): boolean {
    return plugin.target?.scope === 'hub'
        && !plugin.runtimes.hub
        && Boolean(plugin.runtimes.runner)
}

function primaryPluginRank(plugin: PluginListItem): number {
    return (plugin.active ? 1000 : 0)
        + (plugin.enabled ? 500 : 0)
        + pluginStatusRank(plugin.status)
        + (isHubDescriptorMirror(plugin) ? -100 : 0)
        + (plugin.target?.runtime === 'runner' ? 10 : 0)
}

function comparePluginsForDisplay(left: PluginListItem, right: PluginListItem): number {
    return right.id.localeCompare(left.id)
        || (right.target?.scope ?? '').localeCompare(left.target?.scope ?? '')
}

function comparePluginGroupsForDisplay(left: PluginDisplayGroup, right: PluginDisplayGroup): number {
    return left.id.localeCompare(right.id)
}

function pluginScope(plugin: PluginListItem): PluginTargetScope | undefined {
    return plugin.target?.scope as PluginTargetScope | undefined
}

export function preferredPluginDetailTarget(
    plugins: PluginListItem[],
    pluginId: string,
    requestedTarget?: PluginTargetScope
): PluginTargetScope | undefined {
    const entries = plugins.filter((plugin) => plugin.id === pluginId)
    if (entries.length === 0) return requestedTarget

    const requestedEntry = requestedTarget
        ? entries.find((plugin) => plugin.target?.scope === requestedTarget)
        : undefined
    const preferredRunner = entries
        .filter((plugin) => plugin.target?.runtime === 'runner')
        .sort((left, right) => primaryPluginRank(right) - primaryPluginRank(left)
            || (left.target?.scope ?? '').localeCompare(right.target?.scope ?? ''))[0]

    if (requestedEntry && isHubDescriptorMirror(requestedEntry) && preferredRunner) {
        return pluginScope(preferredRunner) ?? requestedTarget
    }
    if (requestedTarget) return requestedTarget

    const preferred = [...entries].sort((left, right) => primaryPluginRank(right) - primaryPluginRank(left)
        || (left.target?.scope ?? '').localeCompare(right.target?.scope ?? ''))[0]
    return preferred ? pluginScope(preferred) : undefined
}

export function groupPluginListForDisplay(plugins: PluginListItem[]): PluginDisplayGroup[] {
    const grouped = new Map<string, PluginListItem[]>()
    for (const plugin of plugins) {
        const existing = grouped.get(plugin.id)
        if (existing) {
            existing.push(plugin)
        } else {
            grouped.set(plugin.id, [plugin])
        }
    }

    return Array.from(grouped.entries())
        .map(([id, entries]) => {
            const sorted = [...entries].sort((left, right) =>
                primaryPluginRank(right) - primaryPluginRank(left)
                    || (left.target?.scope ?? '').localeCompare(right.target?.scope ?? '')
            )
            const primary = sorted[0]!
            const worst = [...sorted].sort((left, right) => pluginStatusRank(right.status) - pluginStatusRank(left.status))[0] ?? primary
            return {
                id,
                name: primary.name ?? sorted.find((plugin) => plugin.name)?.name,
                version: primary.version ?? sorted.find((plugin) => plugin.version)?.version,
                description: primary.description ?? sorted.find((plugin) => plugin.description)?.description,
                display: primary.display ?? sorted.find((plugin) => plugin.display)?.display,
                source: primary.source,
                status: worst.status,
                enabled: sorted.some((plugin) => plugin.enabled),
                active: sorted.some((plugin) => plugin.active),
                diagnostics: sorted.flatMap((plugin) => plugin.diagnostics),
                plugins: sorted.sort(comparePluginsForDisplay),
                primary
            }
        })
        .sort(comparePluginGroupsForDisplay)
}

function formatReloadLines(t: (key: string, params?: Record<string, string | number>) => string, result?: PluginReloadResult): string[] {
    if (!result || result.results.length === 0) {
        return [t('settings.plugins.reloadResult.noChanges')]
    }
    return result.results.map((item) => `${item.id}: ${t(`settings.plugins.action.${item.action}`)} · ${t(`settings.plugins.status.${item.status}`)}${item.message ? ` — ${item.message}` : ''}`)
}

function formatInstallResult(t: (key: string, params?: Record<string, string | number>) => string, result: PluginInstallResult): ResultPayload {
    return {
        title: t('settings.plugins.install.resultTitle'),
        tone: result.ok ? 'success' : 'warning',
        lines: [
            t('settings.plugins.install.resultAction', { action: t(`settings.plugins.install.action.${result.action}`), id: result.pluginId ?? t('settings.plugins.unknown') }),
            t('settings.plugins.install.resultTarget', { path: result.targetPath ?? (result.targetResults ? t('settings.plugins.install.targetCount', { count: result.targetResults.length }) : t('settings.plugins.unknown')) }),
            ...formatReloadLines(t, result.reload)
        ]
    }
}

function formatReloadResult(t: (key: string, params?: Record<string, string | number>) => string, result: PluginReloadResult): ResultPayload {
    return {
        title: t('settings.plugins.result.title'),
        tone: result.ok ? 'success' : 'warning',
        lines: formatReloadLines(t, result)
    }
}

function ResultCard(props: { result: ResultState; onDismiss: () => void }) {
    if (!props.result) return null
    const toneClass = props.result.tone === 'error'
        ? 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
        : props.result.tone === 'warning'
            ? 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
            : 'border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
    return (
        <div className={`mb-3 rounded-xl border p-3 text-sm ${toneClass}`}>
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

function PluginCard(props: {
    group: PluginDisplayGroup
    onClick: () => void
    marketplaceEntry?: PluginMarketplaceEntryView
    updatePending?: boolean
    onReviewUpdate?: () => void
    onUpdate?: () => void
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    const { group, t, locale } = props
    const issueCount = group.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info').length
    const name = localizedPluginName(group, locale)
    const description = localizedPluginDescription(group, locale)
    const latest = props.marketplaceEntry ? latestMarketplaceRelease(props.marketplaceEntry) : undefined
    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-sm transition hover:border-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">
            <button
                type="button"
                onClick={props.onClick}
                className="group flex w-full gap-3 text-left"
            >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--app-secondary-bg)] text-[var(--app-link)]"><PuzzleIcon /></div>
                <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="truncate font-medium">{name}</div>
                            <div className="truncate text-xs text-[var(--app-hint)]">{pluginMeta(t, group, issueCount)}</div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1">
                            <Badge variant={statusVariant(group.status)}>{t(`settings.plugins.status.${group.status}`)}</Badge>
                            {props.marketplaceEntry?.installed?.updateAvailable && latest ? <Badge variant="warning">{t('settings.plugins.marketplace.updateAvailable', { version: props.marketplaceEntry.installed.updateVersion ?? latest.version })}</Badge> : null}
                            {props.marketplaceEntry?.installed?.yanked ? <Badge variant="destructive">{t('settings.plugins.marketplace.yanked')}</Badge> : null}
                        </div>
                    </div>
                    {description ? <div className="line-clamp-2 text-sm text-[var(--app-hint)]">{description}</div> : null}
                    {group.plugins.length > 1 ? (
                        <div className="flex flex-wrap gap-1">
                            {group.plugins.map((plugin) => (
                                <Chip
                                    key={`${group.id}-${plugin.target?.scope ?? 'local'}`}
                                    label={pluginTargetLabel(t, plugin)}
                                    variant={plugin.active ? 'success' : plugin.enabled ? 'warning' : 'default'}
                                />
                            ))}
                        </div>
                    ) : null}
                    {issueCount > 0 ? <div><Chip icon={<AlertIcon />} label={t('settings.plugins.list.diagnostics', { count: issueCount })} variant="warning" /></div> : null}
                </div>
            </button>
            {props.marketplaceEntry?.installed?.updateAvailable ? (
                <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-[var(--app-border)] pt-3">
                    <Button type="button" variant="outline" size="sm" disabled={props.updatePending} onClick={props.onReviewUpdate}>
                        {props.updatePending ? t('settings.plugins.marketplace.reviewing') : t('settings.plugins.marketplace.reviewUpdate')}
                    </Button>
                    <Button type="button" size="sm" disabled={props.updatePending} onClick={props.onUpdate}>
                        {props.updatePending ? t('settings.plugins.marketplace.updating') : t('settings.plugins.marketplace.action.update')}
                    </Button>
                </div>
            ) : null}
        </div>
    )
}

function latestMarketplaceRelease(entry: PluginMarketplaceEntryView): PluginMarketplaceEntryView['releases'][number] | undefined {
    return entry.latestCompatibleVersion
        ? entry.releases.find((release) => release.version === entry.latestCompatibleVersion && !release.yanked)
        : undefined
}

function marketplaceReleaseForVersion(entry: PluginMarketplaceEntryView, version?: string): PluginMarketplaceEntryView['releases'][number] | undefined {
    if (!version) return latestMarketplaceRelease(entry)
    return entry.releases.find((release) => release.version === version && !release.yanked) ?? latestMarketplaceRelease(entry)
}

function marketplaceInstalledVersions(entry: PluginMarketplaceEntryView): string[] {
    return entry.installed?.version
        ?.split('+')
        .map((version) => version.trim())
        .filter(Boolean) ?? []
}

export function marketplaceHasLocalNewerVersion(entry: PluginMarketplaceEntryView, version?: string): boolean {
    const release = marketplaceReleaseForVersion(entry, version)
    if (!release) return false
    return marketplaceInstalledVersions(entry).some((installedVersion) => comparePluginVersions(installedVersion, release.version) > 0)
}

function marketplaceEntryMatchesSearch(entry: PluginMarketplaceEntryView, query: string): boolean {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return true
    const haystack = [
        entry.id,
        entry.name,
        entry.description ?? '',
        entry.repo,
        ...(entry.keywords ?? []),
        ...(entry.categories ?? [])
    ].join('\n').toLowerCase()
    return haystack.includes(normalized)
}

type MarketplaceInstallIntent = 'install' | 'update' | 'reinstall' | 'installed' | 'localNewer'

function marketplaceInstallIntent(entry: PluginMarketplaceEntryView, overwrite: boolean, version?: string): MarketplaceInstallIntent {
    if (!entry.installed) return 'install'
    if (entry.installed.updateAvailable) return 'update'
    if (overwrite) return 'reinstall'
    if (marketplaceHasLocalNewerVersion(entry, version)) return 'localNewer'
    return 'installed'
}

function marketplaceInstallButtonLabel(
    t: (key: string, params?: Record<string, string | number>) => string,
    intent: MarketplaceInstallIntent
): string {
    return t(`settings.plugins.marketplace.action.${intent}`)
}

function marketplaceActionEnabled(intent: MarketplaceInstallIntent): boolean {
    return intent !== 'installed' && intent !== 'localNewer'
}

export function MarketplacePluginCard(props: {
    entry: PluginMarketplaceEntryView
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
    disabled: boolean
    overwrite: boolean
    pendingAction: MarketplacePendingAction | null
    expanded: boolean
    onDetails: () => void
    onInstall: () => void
    children?: ReactNode
}) {
    const { entry, t, locale } = props
    const latest = latestMarketplaceRelease(entry)
    const localNewer = marketplaceHasLocalNewerVersion(entry)
    const intent = marketplaceInstallIntent(entry, props.overwrite)
    const name = localizedPluginName(entry, locale)
    const description = localizedPluginDescription(entry, locale)
    const installLabel = props.pendingAction === 'install'
        ? t('settings.plugins.marketplace.installing')
        : marketplaceInstallButtonLabel(t, intent)
    const tags = [
        ...(entry.categories ?? []),
        ...(entry.runtimes ?? []).map((runtime) => t(`settings.plugins.runtime.${runtime}`))
    ]
    return (
        <div
            data-plugin-id={entry.id}
            data-expanded={props.expanded ? 'true' : 'false'}
            className={`min-w-0 overflow-hidden rounded-xl border bg-[var(--app-bg)] p-3 shadow-sm ${props.expanded ? 'border-[var(--app-link)]' : 'border-[var(--app-border)]'}`}
        >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{name}</div>
                    <div className="truncate text-xs text-[var(--app-hint)]">
                        {entry.id} · {latest?.version ?? t('settings.plugins.unknown')} · {entry.repo}
                    </div>
                </div>
                <div className="flex min-w-0 flex-wrap justify-start gap-1 sm:justify-end">
                    {entry.installed ? <Badge variant="success">{t('settings.plugins.marketplace.installed', { version: entry.installed.version ?? '' })}</Badge> : null}
                    {entry.installed?.updateAvailable && latest ? <Badge variant="warning">{t('settings.plugins.marketplace.updateAvailable', { version: entry.installed.updateVersion ?? latest.version })}</Badge> : null}
                    {localNewer && !entry.installed?.updateAvailable ? <Badge variant="warning">{t('settings.plugins.marketplace.localNewer')}</Badge> : null}
                    {entry.installed?.yanked ? <Badge variant="destructive">{t('settings.plugins.marketplace.yanked')}</Badge> : null}
                </div>
            </div>
            {description ? <div className="mt-2 line-clamp-2 min-w-0 break-words text-sm text-[var(--app-hint)]">{description}</div> : null}
            {tags.length > 0 ? (
                <div className="mt-2 flex min-w-0 flex-wrap gap-1">
                    {tags.map((tag) => <Chip key={`${entry.id}-${tag}`} label={tag} />)}
                </div>
            ) : null}
            <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <a
                    href={`https://github.com/${entry.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 break-all text-xs text-[var(--app-link)] hover:underline"
                >
                    {t('settings.plugins.marketplace.viewRepo')}
                </a>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                    <Button type="button" variant="secondary" size="sm" disabled={props.disabled} onClick={props.onDetails} className="w-full min-w-0 max-w-full overflow-hidden text-ellipsis sm:w-auto">
                        {props.expanded ? t('settings.plugins.marketplace.closeDetails') : t('settings.plugins.marketplace.details')}
                    </Button>
                    <Button type="button" size="sm" disabled={props.disabled || Boolean(props.pendingAction) || !marketplaceActionEnabled(intent)} onClick={props.onInstall} className="w-full min-w-0 max-w-full overflow-hidden text-ellipsis sm:w-auto">
                        {installLabel}
                    </Button>
                </div>
            </div>
            {props.expanded ? (
                <div className="mt-3 border-t border-[var(--app-border)] pt-3">
                    {props.children}
                </div>
            ) : null}
        </div>
    )
}

function EmptyState(props: {
    filtered: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const title = props.filtered ? props.t('settings.plugins.empty.filteredTitle') : props.t('settings.plugins.empty.title')
    return (
        <Card className="border border-dashed border-[var(--app-border)] bg-[var(--app-bg)]">
            <CardContent className="flex items-center justify-center gap-3 p-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--app-secondary-bg)] text-[var(--app-link)]"><PuzzleIcon /></div>
                <div className="font-semibold">{title}</div>
            </CardContent>
        </Card>
    )
}

async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return btoa(binary)
}

async function fileSha256(file: File): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function packageFormat(filename: string): 'tgz' | 'zip' | undefined {
    const lowered = filename.toLowerCase()
    if (lowered.endsWith('.zip')) return 'zip'
    if (lowered.endsWith('.tgz') || lowered.endsWith('.tar.gz')) return 'tgz'
    return undefined
}

function planActionVariant(action: string): BadgeVariant {
    if (action === 'install' || action === 'overwrite' || action === 'unchanged') return 'success'
    if (action === 'skip') return 'warning'
    return 'destructive'
}

function InstallPlanCard(props: {
    plan: PluginInstallPlanResponse | null
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
}) {
    if (!props.plan) return null
    const { plan, t } = props
    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="font-medium">{t('settings.plugins.install.planTitle')}</div>
                    <div className="text-xs text-[var(--app-hint)]">{localizedPluginName(plan.plugin, props.locale)} · {plan.plugin.version}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                    {plan.positions.map((position) => <Badge key={position} variant="default">{t(`settings.plugins.install.position.${position}`)}</Badge>)}
                </div>
            </div>
            {plan.warnings.length > 0 ? (
                <ul className="mb-2 space-y-1 rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2 text-xs text-[var(--app-badge-warning-text)]">
                    {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
            ) : null}
            {plan.blockingErrors.length > 0 ? (
                <ul className="mb-2 space-y-1 rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-2 text-xs text-[var(--app-badge-error-text)]">
                    {plan.blockingErrors.map((blockingError) => <li key={blockingError}>{blockingError}</li>)}
                </ul>
            ) : null}
            <div className="space-y-2">
                {plan.targets.map((target) => (
                    <div key={target.target.scope} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="font-medium">{targetLabel(t, target.target)}</div>
                                <div className="text-xs text-[var(--app-hint)]">
                                    {target.target.hostInfo
                                        ? `${target.target.hostInfo.hapiVersion} · API ${target.target.hostInfo.pluginApiVersion} · ${target.target.hostInfo.os}/${target.target.hostInfo.arch}`
                                        : t('settings.plugins.install.hostUnknown')}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                <Badge variant={target.compatible ? 'success' : 'warning'}>{t(`settings.plugins.install.status.${target.status}`)}</Badge>
                                <Badge variant={planActionVariant(target.action)}>{t(`settings.plugins.install.planAction.${target.action}`)}</Badge>
                            </div>
                        </div>
                        {target.reason ? <div className="mt-1 text-xs text-[var(--app-hint)]">{target.reason}</div> : null}
                    </div>
                ))}
            </div>
        </div>
    )
}

function formatPackageSize(size?: number): string {
    if (size === undefined) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`
}

export function MarketplaceDetailPanel(props: {
    entry: PluginMarketplaceEntryView
    version?: string
    plan: PluginInstallPlanResponse | null
    pendingAction: MarketplacePendingAction | null
    overwrite: boolean
    t: (key: string, params?: Record<string, string | number>) => string
    locale: 'en' | 'zh-CN'
    onVersionChange: (version: string) => void
}) {
    const { entry, t, locale } = props
    const release = marketplaceReleaseForVersion(entry, props.version)
    const localNewer = marketplaceHasLocalNewerVersion(entry, props.version)
    const installedVersion = marketplaceInstalledVersions(entry).join(' + ')
    const name = localizedPluginName(entry, locale)
    const description = localizedPluginDescription(entry, locale)
    const featureIntro = localizedText(entry.display?.featureIntro, locale).trim()
        || localizedText(release?.manifest.display?.featureIntro, locale).trim()
    const network = release?.manifest.permissions?.network ?? []
    const secrets = release?.manifest.permissions?.secrets ?? []
    const packageSize = formatPackageSize(release?.package?.size)

    return (
        <div className="space-y-3">
            <div className="min-w-0">
                <div className="text-base font-semibold">{name}</div>
                <div className="break-all text-xs text-[var(--app-hint)]">{entry.id} · {entry.repo}</div>
                {description ? <div className="mt-2 text-sm text-[var(--app-hint)]">{description}</div> : null}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-lg bg-[var(--app-subtle-bg)] p-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">{t('settings.plugins.marketplace.repo')}</div>
                    <a href={`https://github.com/${entry.repo}`} target="_blank" rel="noreferrer" className="break-all text-[var(--app-link)] hover:underline">{entry.repo}</a>
                </div>
                <div className="rounded-lg bg-[var(--app-subtle-bg)] p-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">{t('settings.plugins.marketplace.version')}</div>
                    <select
                        value={release?.version ?? ''}
                        onChange={(event) => props.onVersionChange(event.target.value)}
                        className="mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)]"
                    >
                        {entry.releases.map((candidate) => (
                            <option key={candidate.version} value={candidate.version} disabled={Boolean(candidate.yanked)}>
                                {candidate.version}{candidate.yanked ? ` · ${t('settings.plugins.marketplace.yanked')}` : ''}
                            </option>
                        ))}
                    </select>
                </div>
                {entry.homepage ? (
                    <div className="rounded-lg bg-[var(--app-subtle-bg)] p-2">
                        <div className="text-xs font-medium text-[var(--app-hint)]">{t('settings.plugins.marketplace.homepage')}</div>
                        <a href={entry.homepage} target="_blank" rel="noreferrer" className="break-all text-[var(--app-link)] hover:underline">{entry.homepage}</a>
                    </div>
                ) : null}
                {entry.author?.name || entry.license ? (
                    <div className="rounded-lg bg-[var(--app-subtle-bg)] p-2">
                        <div className="text-xs font-medium text-[var(--app-hint)]">{t('settings.plugins.marketplace.publisher')}</div>
                        <div>{entry.author?.name ?? t('settings.plugins.unknown')}{entry.license ? ` · ${entry.license}` : ''}</div>
                    </div>
                ) : null}
            </div>

            {featureIntro ? (
                <div className="rounded-lg border border-[var(--app-border)] p-3">
                    <div className="mb-2 text-sm font-medium">{t('settings.plugins.detail.featureIntro.title')}</div>
                    <MarkdownRenderer content={featureIntro} className="text-sm" />
                </div>
            ) : null}

            <div className="space-y-2 rounded-lg border border-[var(--app-border)] p-3 text-sm">
                <div className="font-medium">{t('settings.plugins.marketplace.packageDetails')}</div>
                <div className="break-all text-xs text-[var(--app-hint)]">
                    {release?.package?.filename ?? release?.source?.path ?? t('settings.plugins.unknown')}{packageSize ? ` · ${packageSize}` : ''}
                </div>
                {release?.package?.url ? <div className="break-all text-xs text-[var(--app-hint)]">{release.package.url}</div> : null}
                {release?.package?.checksum ? <div className="break-all text-xs text-[var(--app-hint)]">{t('settings.plugins.marketplace.checksum')}: {release.package.checksum}</div> : null}
                {release?.source?.treeChecksum ? <div className="break-all text-xs text-[var(--app-hint)]">{t('settings.plugins.marketplace.checksum')}: {release.source.treeChecksum}</div> : null}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--app-border)] p-3">
                    <div className="mb-2 font-medium">{t('settings.plugins.detail.permissions')}</div>
                    <div className="space-y-1 text-xs text-[var(--app-hint)]">
                        <div>{t('settings.plugins.detail.networkLabel')}: {network.length ? network.join(', ') : t('settings.plugins.permissions.networkEmpty')}</div>
                        <div>{t('settings.plugins.detail.secretsLabel')}: {secrets.length ? secrets.join(', ') : t('settings.plugins.permissions.secretsEmpty')}</div>
                        <div className="pt-1">{t('settings.plugins.detail.permissionsDescription')}</div>
                    </div>
                </div>
                <div className="rounded-lg border border-[var(--app-border)] p-3">
                    <div className="mb-2 font-medium">{t('settings.plugins.marketplace.features')}</div>
                    <div className="flex flex-wrap gap-1">
                        {(entry.capabilities ?? []).length > 0
                            ? entry.capabilities?.map((capability) => <Chip key={`${entry.id}-${capability.kind}`} label={capability.label ?? t(`settings.plugins.capabilityKind.${capability.kind}`)} />)
                            : <span className="text-xs text-[var(--app-hint)]">{t('settings.plugins.detail.noContributions')}</span>}
                    </div>
                </div>
            </div>

            {localNewer && !props.overwrite && release ? (
                <div className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2 text-xs text-[var(--app-badge-warning-text)]">
                    {t('settings.plugins.marketplace.localVersionNewer', { installed: installedVersion, version: release.version })}
                </div>
            ) : null}

            {props.pendingAction === 'check' ? <LoadingState label={t('settings.plugins.marketplace.checkingInstall')} className="p-2" /> : null}
            <InstallPlanCard plan={props.plan} t={t} locale={locale} />
        </div>
    )
}

export default function PluginsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { t, locale } = useTranslation()
    const { plugins, isLoading, error, refetch } = usePlugins(api)
    const actions = usePluginActions(api)
    const [activeTab, setActiveTab] = useState<PluginSettingsTab>(DEFAULT_PLUGIN_SETTINGS_TAB)
    const [filter, setFilter] = useState<PluginFilter>('all')
    const [result, setResult] = useState<ResultState>(null)
    const [enableAfterInstall, setEnableAfterInstall] = useState(false)
    const [overwriteLocal, setOverwriteLocal] = useState(false)
    const [packageFile, setPackageFile] = useState<File | null>(null)
    const [installPlan, setInstallPlan] = useState<PluginInstallPlanResponse | null>(null)
    const [marketplaceSearch, setMarketplaceSearch] = useState('')
    const [enableMarketplaceAfterInstall, setEnableMarketplaceAfterInstall] = useState(true)
    const [overwriteMarketplace, setOverwriteMarketplace] = useState(false)
    const [marketplacePlan, setMarketplacePlan] = useState<MarketplacePlanState>(null)
    const [marketplacePlanErrorKey, setMarketplacePlanErrorKey] = useState<string | null>(null)
    const [checkingMarketplaceUpdates, setCheckingMarketplaceUpdates] = useState(false)
    const [marketplacePending, setMarketplacePending] = useState<{ pluginId: string; action: MarketplacePendingAction } | null>(null)
    const [selectedMarketplaceEntryId, setSelectedMarketplaceEntryId] = useState<string | null>(null)
    const [marketplaceVersions, setMarketplaceVersions] = useState<Record<string, string>>({})
    const [autoCheckedMarketplace, setAutoCheckedMarketplace] = useState(false)
    const marketplace = usePluginMarketplace(api)

    const pluginGroups = useMemo(() => groupPluginListForDisplay(plugins), [plugins])
    const marketplaceEntries = useMemo(() => (
        marketplace.entries.filter((entry) => marketplaceEntryMatchesSearch(entry, marketplaceSearch))
    ), [marketplace.entries, marketplaceSearch])
    const marketplaceById = useMemo(() => new Map(marketplace.entries.map((entry) => [entry.id, entry])), [marketplace.entries])
    const marketplaceUpdateCount = useMemo(() => marketplace.entries.filter((entry) => entry.installed?.updateAvailable).length, [marketplace.entries])
    const marketplaceYankedCount = useMemo(() => marketplace.entries.filter((entry) => entry.installed?.yanked).length, [marketplace.entries])
    const selectedMarketplaceEntry = useMemo(() => (
        selectedMarketplaceEntryId
            ? marketplace.entries.find((entry) => entry.id === selectedMarketplaceEntryId) ?? null
            : null
    ), [marketplace.entries, selectedMarketplaceEntryId])
    const selectedMarketplaceVersion = selectedMarketplaceEntry ? marketplaceVersions[selectedMarketplaceEntry.id] : undefined
    const selectedMarketplaceLocalNewer = selectedMarketplaceEntry
        ? marketplaceHasLocalNewerVersion(selectedMarketplaceEntry, selectedMarketplaceVersion)
        : false

    useEffect(() => {
        setInstallPlan(null)
    }, [packageFile, enableAfterInstall, overwriteLocal])

    useEffect(() => {
        setMarketplacePlan(null)
        setMarketplacePlanErrorKey(null)
    }, [enableMarketplaceAfterInstall, overwriteMarketplace, selectedMarketplaceVersion])

    useEffect(() => {
        if (!api || autoCheckedMarketplace) return
        setAutoCheckedMarketplace(true)
        void api.refreshPluginMarketplace()
            .then(() => marketplace.refetch())
            .catch(() => undefined)
    }, [api, autoCheckedMarketplace, marketplace.refetch])

    useEffect(() => {
        if (!api) return undefined
        const interval = window.setInterval(() => {
            void api.refreshPluginMarketplace()
                .then(() => marketplace.refetch())
                .catch(() => undefined)
        }, 10 * 60 * 1000)
        return () => window.clearInterval(interval)
    }, [api, marketplace.refetch])

    const counts = useMemo(() => ({
        all: pluginGroups.length,
        active: pluginGroups.filter((group) => group.active).length,
        enabled: pluginGroups.filter((group) => group.enabled).length,
        issues: pluginGroups.filter(pluginGroupHasIssue).length
    }), [pluginGroups])

    const filtered = useMemo(() => pluginGroups.filter((group) => {
        if (filter === 'active') return group.active
        if (filter === 'enabled') return group.enabled
        if (filter === 'issues') return pluginGroupHasIssue(group)
        return true
    }), [filter, pluginGroups])

    const runWithResult = async (work: () => Promise<ResultState>) => {
        try {
            setResult(await work())
        } catch (err) {
            setResult({
                title: t('settings.plugins.error.title'),
                tone: 'error',
                lines: [err instanceof Error ? err.message : String(err)]
            })
        }
    }

    const createPackageInstallPlan = async (): Promise<PluginInstallPlanResponse | null> => {
        if (!packageFile) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] })
            return null
        }
        const format = packageFormat(packageFile.name)
        if (!format) {
            setResult({ title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageInvalid')] })
            return null
        }
        const plan = await actions.createInstallPlan({
            filename: packageFile.name,
            contentBase64: await fileToBase64(packageFile),
            checksum: await fileSha256(packageFile),
            format,
            enable: enableAfterInstall,
            overwrite: overwriteLocal,
            reload: true
        })
        setInstallPlan(plan)
        if (plan.blockingErrors.length > 0) {
            setResult({
                title: t('settings.plugins.install.planBlocked'),
                tone: 'warning',
                lines: plan.blockingErrors
            })
        } else {
            setResult({
                title: t('settings.plugins.install.planReady'),
                tone: 'success',
                lines: [t('settings.plugins.install.planTargets', { count: plan.targets.filter((target) => target.action !== 'skip' && target.action !== 'block').length })]
            })
        }
        return plan
    }

    const previewInstallPlan = async () => {
        await runWithResult(async () => {
            const plan = await createPackageInstallPlan()
            if (!plan) return { title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] }
            return {
                title: plan.blockingErrors.length > 0 ? t('settings.plugins.install.planBlocked') : t('settings.plugins.install.planReady'),
                tone: plan.blockingErrors.length > 0 ? 'warning' : 'success',
                lines: plan.blockingErrors.length > 0
                    ? plan.blockingErrors
                    : [t('settings.plugins.install.planTargets', { count: plan.targets.filter((target) => target.action !== 'skip' && target.action !== 'block').length })]
            }
        })
    }

    const installPackage = async () => {
        await runWithResult(async () => {
            const plan = installPlan ?? await createPackageInstallPlan()
            if (!plan) {
                return { title: t('settings.plugins.error.title'), tone: 'error', lines: [t('settings.plugins.install.packageRequired')] }
            }
            if (plan.blockingErrors.length > 0) {
                return { title: t('settings.plugins.install.planBlocked'), tone: 'warning', lines: plan.blockingErrors }
            }
            return formatInstallResult(t, await actions.executeInstallPlan(plan.planId))
        })
        setInstallPlan(null)
    }

    const marketplacePlanKeyForEntry = (entry: PluginMarketplaceEntryView): string => createMarketplaceInstallPlanKey({
        pluginId: entry.id,
        version: marketplaceVersions[entry.id],
        enable: enableMarketplaceAfterInstall,
        overwrite: overwriteMarketplace,
        updateAvailable: entry.installed?.updateAvailable
    })

    const marketplacePlanResult = (planPayload: PluginMarketplaceInstallPlanResponse): ResultPayload => ({
        title: planPayload.plan.blockingErrors.length > 0 ? t('settings.plugins.install.planBlocked') : t('settings.plugins.install.planReady'),
        tone: planPayload.plan.blockingErrors.length > 0 ? 'warning' : 'success',
        lines: planPayload.plan.blockingErrors.length > 0
            ? planPayload.plan.blockingErrors
            : [
                t('settings.plugins.marketplace.release', { version: planPayload.marketplace.version, repo: planPayload.marketplace.repo }),
                t('settings.plugins.install.planTargets', { count: planPayload.plan.targets.filter((target) => target.action !== 'skip' && target.action !== 'block').length })
            ]
    })

    const createMarketplacePlan = async (
        entry: PluginMarketplaceEntryView,
        options: { key?: string; silent?: boolean } = {}
    ): Promise<PluginMarketplaceInstallPlanResponse> => {
        const shouldOverwrite = overwriteMarketplace || entry.installed?.updateAvailable === true
        const version = marketplaceVersions[entry.id]
        const key = options.key ?? marketplacePlanKeyForEntry(entry)
        const planPayload = await actions.createMarketplaceInstallPlan(entry.id, {
            ...(version ? { version } : {}),
            enable: enableMarketplaceAfterInstall,
            overwrite: shouldOverwrite,
            reload: true,
            runnerSelection: { mode: 'compatible' }
        })
        setMarketplacePlan({ key, response: planPayload })
        setMarketplacePlanErrorKey(null)
        if (!options.silent) {
            setResult(marketplacePlanResult(planPayload))
        }
        return planPayload
    }

    const checkMarketplaceInstallPlan = async (
        entry: PluginMarketplaceEntryView,
        options: { force?: boolean; silent?: boolean } = {}
    ): Promise<PluginMarketplaceInstallPlanResponse> => {
        const key = marketplacePlanKeyForEntry(entry)
        if (!options.force && marketplacePlan?.key === key) return marketplacePlan.response
        setMarketplacePending({ pluginId: entry.id, action: 'check' })
        try {
            return await createMarketplacePlan(entry, { key, silent: options.silent })
        } catch (err) {
            setMarketplacePlan((current) => current?.key === key ? null : current)
            setMarketplacePlanErrorKey(key)
            setResult({
                title: t('settings.plugins.error.title'),
                tone: 'error',
                lines: [err instanceof Error ? err.message : String(err)]
            })
            throw err
        } finally {
            setMarketplacePending((current) => current?.pluginId === entry.id && current.action === 'check' ? null : current)
        }
    }

    useEffect(() => {
        if (!selectedMarketplaceEntry) return
        const key = marketplacePlanKeyForEntry(selectedMarketplaceEntry)
        if (selectedMarketplaceLocalNewer && !overwriteMarketplace) {
            setMarketplacePlan((current) => current?.key === key ? null : current)
            setMarketplacePlanErrorKey((current) => current === key ? null : current)
            return
        }
        if (marketplacePlan?.key === key) return
        if (marketplacePlanErrorKey === key) return
        if (marketplacePending) return
        void checkMarketplaceInstallPlan(selectedMarketplaceEntry, { silent: true }).catch(() => undefined)
    }, [
        selectedMarketplaceEntry,
        selectedMarketplaceVersion,
        selectedMarketplaceLocalNewer,
        enableMarketplaceAfterInstall,
        overwriteMarketplace,
        marketplacePlan?.key,
        marketplacePlanErrorKey,
        marketplacePending
    ])

    const installMarketplacePlugin = async (entry: PluginMarketplaceEntryView) => {
        setMarketplacePlanErrorKey(null)
        setSelectedMarketplaceEntryId(entry.id)
        setMarketplacePending({ pluginId: entry.id, action: 'install' })
        try {
            await runWithResult(async () => {
                const key = marketplacePlanKeyForEntry(entry)
                const planPayload = marketplacePlan?.key === key
                    ? marketplacePlan.response
                    : await createMarketplacePlan(entry, { key, silent: true })
                if (planPayload.plan.blockingErrors.length > 0) {
                    return { title: t('settings.plugins.install.planBlocked'), tone: 'warning', lines: planPayload.plan.blockingErrors }
                }
                const installResult = await actions.executeInstallPlan(planPayload.plan.planId)
                const formatted = formatInstallResult(t, installResult)
                return {
                    ...formatted,
                    lines: [
                        t('settings.plugins.marketplace.release', { version: planPayload.marketplace.version, repo: planPayload.marketplace.repo }),
                        ...formatted.lines
                    ]
                }
            })
            setMarketplacePlan(null)
        } finally {
            setMarketplacePending(null)
        }
    }

    const checkMarketplaceUpdates = async () => {
        setCheckingMarketplaceUpdates(true)
        try {
            await runWithResult(async () => {
                if (!api) throw new Error('API unavailable')
                const response = await api.refreshPluginMarketplace()
                await marketplace.refetch()
                const updateCount = response.entries.filter((entry) => entry.installed?.updateAvailable).length
                const yankedCount = response.entries.filter((entry) => entry.installed?.yanked).length
                return {
                    title: t('settings.plugins.marketplace.updateCheckTitle'),
                    tone: updateCount > 0 || yankedCount > 0 ? 'warning' : 'success',
                    lines: [
                        updateCount > 0
                            ? t('settings.plugins.marketplace.updatesFound', { count: updateCount })
                            : t('settings.plugins.marketplace.noUpdates'),
                        ...(yankedCount > 0 ? [t('settings.plugins.marketplace.yankedFound', { count: yankedCount })] : []),
                        t('settings.plugins.marketplace.lastChecked', { date: new Date(response.fetchedAt).toLocaleString() })
                    ]
                }
            })
        } finally {
            setCheckingMarketplaceUpdates(false)
        }
    }

    const reviewMarketplaceUpdate = (entry: PluginMarketplaceEntryView) => {
        setActiveTab('marketplace')
        setMarketplacePlanErrorKey(null)
        setSelectedMarketplaceEntryId(entry.id)
        void checkMarketplaceInstallPlan(entry, { force: true, silent: true }).catch(() => undefined)
    }

    const installMarketplaceUpdate = (entry: PluginMarketplaceEntryView) => {
        setMarketplacePlanErrorKey(null)
        setSelectedMarketplaceEntryId(entry.id)
        void installMarketplacePlugin(entry)
    }

    const selectedMarketplacePlan = selectedMarketplaceEntry && marketplacePlan?.key === marketplacePlanKeyForEntry(selectedMarketplaceEntry)
        ? marketplacePlan.response.plan
        : null

    const reloadAll = async () => {
        await runWithResult(async () => formatReloadResult(t, await actions.reloadPlugins()))
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <Button type="button" variant="secondary" size="sm" onClick={goBack} className="h-8 w-8 rounded-full p-0"><BackIcon /></Button>
                    <div className="min-w-0 flex-1">
                        <div className="font-semibold">{t('settings.plugins.title')}</div>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>{t('settings.plugins.refresh')}</Button>
                    <Button type="button" size="sm" disabled={actions.isPending} onClick={() => void reloadAll()}>{t('settings.plugins.reloadAll')}</Button>
                </div>
            </div>
            <div className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-content space-y-3 p-3">
                    <div className="flex rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1">
                        <button
                            type="button"
                            onClick={() => setActiveTab('installed')}
                            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeTab === 'installed' ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        >
                            {t('settings.plugins.tabs.installed')} · {counts.all}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('marketplace')}
                            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${activeTab === 'marketplace' ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        >
                            {t('settings.plugins.tabs.marketplace')} · {marketplace.entries.length}{marketplaceUpdateCount > 0 ? ` · ${t('settings.plugins.marketplace.updatesShort', { count: marketplaceUpdateCount })}` : ''}
                        </button>
                    </div>

                    <ResultCard result={result} onDismiss={() => setResult(null)} />

                    {activeTab === 'marketplace' ? (
                        <div className="space-y-3">
                            <Card className="border border-[var(--app-border)] bg-[var(--app-bg)]">
                                <CardContent className="space-y-3 p-3">
                                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="font-medium">{t('settings.plugins.marketplace.title')}</div>
                                            <div className="break-all text-xs text-[var(--app-hint)]">
                                                {marketplace.sourceUrl ? t('settings.plugins.marketplace.source', { source: marketplace.sourceUrl }) : t('settings.plugins.marketplace.description')}
                                            </div>
                                        </div>
                                        <Button type="button" variant="outline" size="sm" disabled={marketplace.isFetching || checkingMarketplaceUpdates} onClick={() => void checkMarketplaceUpdates()}>
                                            {checkingMarketplaceUpdates ? t('settings.plugins.marketplace.checkingUpdates') : t('settings.plugins.marketplace.checkUpdates')}
                                        </Button>
                                    </div>
                                    {marketplace.fetchedAt ? (
                                        <div className="text-xs text-[var(--app-hint)]">{t('settings.plugins.marketplace.lastChecked', { date: new Date(marketplace.fetchedAt).toLocaleString() })}</div>
                                    ) : null}
                                    <div className="flex flex-wrap gap-2">
                                        <input
                                            type="search"
                                            value={marketplaceSearch}
                                            onChange={(event) => setMarketplaceSearch(event.target.value)}
                                            placeholder={t('settings.plugins.marketplace.searchPlaceholder')}
                                            className="min-h-9 min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                                        />
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={enableMarketplaceAfterInstall} onChange={(event) => setEnableMarketplaceAfterInstall(event.target.checked)} />{t('settings.plugins.install.enableAfterInstall')}</label>
                                        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={overwriteMarketplace} onChange={(event) => setOverwriteMarketplace(event.target.checked)} />{t('settings.plugins.install.overwriteExisting')}</label>
                                    </div>
                                    <div className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2 text-xs text-[var(--app-badge-warning-text)]">
                                        {t('settings.plugins.marketplace.trustWarning')}
                                    </div>
                                    {marketplaceUpdateCount > 0 || marketplaceYankedCount > 0 ? (
                                        <div className="flex flex-wrap gap-2">
                                            {marketplaceUpdateCount > 0 ? <Chip label={t('settings.plugins.marketplace.updatesFound', { count: marketplaceUpdateCount })} variant="warning" /> : null}
                                            {marketplaceYankedCount > 0 ? <Chip label={t('settings.plugins.marketplace.yankedFound', { count: marketplaceYankedCount })} variant="destructive" /> : null}
                                        </div>
                                    ) : null}
                                    {marketplace.error ? <div className="rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-2 text-sm text-[var(--app-badge-error-text)]">{marketplace.error}</div> : null}
                                    {marketplace.isLoading ? <LoadingState label={t('settings.plugins.marketplace.loading')} className="p-2" /> : null}
                                    {!marketplace.isLoading && !marketplace.error && marketplaceEntries.length === 0 ? (
                                        <div className="rounded-lg border border-dashed border-[var(--app-border)] p-3 text-center text-sm text-[var(--app-hint)]">{t('settings.plugins.marketplace.empty')}</div>
                                    ) : null}
                                </CardContent>
                            </Card>

                            <div className="grid min-w-0 gap-2">
                                {marketplaceEntries.map((entry) => {
                                    const expanded = selectedMarketplaceEntry?.id === entry.id
                                    return (
                                        <MarketplacePluginCard
                                            key={entry.id}
                                            entry={entry}
                                            t={t}
                                            locale={locale}
                                            disabled={Boolean(marketplacePending && marketplacePending.pluginId !== entry.id)}
                                            overwrite={overwriteMarketplace}
                                            pendingAction={marketplacePending?.pluginId === entry.id ? marketplacePending.action : null}
                                            expanded={expanded}
                                            onDetails={() => {
                                                if (!expanded) setMarketplacePlanErrorKey(null)
                                                setSelectedMarketplaceEntryId(expanded ? null : entry.id)
                                            }}
                                            onInstall={() => void installMarketplacePlugin(entry)}
                                        >
                                            {expanded ? (
                                                <MarketplaceDetailPanel
                                                    entry={entry}
                                                    version={marketplaceVersions[entry.id]}
                                                    plan={selectedMarketplacePlan}
                                                    pendingAction={marketplacePending?.pluginId === entry.id ? marketplacePending.action : null}
                                                    overwrite={overwriteMarketplace}
                                                    t={t}
                                                    locale={locale}
                                                    onVersionChange={(version) => setMarketplaceVersions((current) => ({ ...current, [entry.id]: version }))}
                                                />
                                            ) : null}
                                        </MarketplacePluginCard>
                                    )
                                })}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <Card className="border border-[var(--app-border)] bg-[var(--app-bg)]">
                                <CardContent className="space-y-2 p-3">
                                    <div className="font-medium">{t('settings.plugins.install.title')}</div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <label
                                            htmlFor="plugin-package-file"
                                            className={`inline-flex h-8 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 text-sm font-medium text-[var(--app-fg)] transition ${actions.isPending ? 'pointer-events-none opacity-60' : 'cursor-pointer hover:bg-[var(--app-subtle-bg)]'}`}
                                        >
                                            {t('settings.plugins.install.choosePackage')}
                                        </label>
                                        <input
                                            id="plugin-package-file"
                                            type="file"
                                            accept=".tgz,.tar.gz,.zip"
                                            disabled={actions.isPending}
                                            onChange={(event) => setPackageFile(event.target.files?.[0] ?? null)}
                                            className="sr-only"
                                        />
                                        <Button type="button" variant="outline" size="sm" disabled={actions.isPending || !packageFile} onClick={() => void previewInstallPlan()}>{t('settings.plugins.install.previewPlan')}</Button>
                                        <Button type="button" size="sm" disabled={actions.isPending || !packageFile || (installPlan?.blockingErrors.length ?? 0) > 0} onClick={() => void installPackage()}>{t('settings.plugins.install.installPackage')}</Button>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={enableAfterInstall} onChange={(event) => setEnableAfterInstall(event.target.checked)} />{t('settings.plugins.install.enableAfterInstall')}</label>
                                        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-hint)]"><input type="checkbox" checked={overwriteLocal} onChange={(event) => setOverwriteLocal(event.target.checked)} />{t('settings.plugins.install.overwriteExisting')}</label>
                                    </div>
                                    {packageFile ? (
                                        <div className="w-full min-w-0 truncate text-xs text-[var(--app-hint)]" title={packageFile.name}>
                                            {t('settings.plugins.install.selectedPackage', { filename: packageFile.name })}
                                        </div>
                                    ) : null}
                                    <InstallPlanCard plan={installPlan} t={t} locale={locale} />
                                </CardContent>
                            </Card>

                            <div className="flex flex-wrap gap-2" aria-label={t('settings.plugins.filterLabel')}>
                                {(['all', 'active', 'enabled', 'issues'] as const).map((entry) => (
                                    <Button key={entry} type="button" size="sm" variant={filter === entry ? 'secondary' : 'outline'} onClick={() => setFilter(entry)}>
                                        {t(`settings.plugins.filter.${entry}`)} · {counts[entry]}
                                    </Button>
                                ))}
                            </div>

                            {error ? <div className="rounded-xl border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{error}</div> : null}
                            {isLoading ? <LoadingState label={t('settings.plugins.loading')} className="p-2" /> : null}
                            {!isLoading && filtered.length === 0 ? <EmptyState filtered={filter !== 'all'} t={t} /> : null}
                            <div className="space-y-2">
                                {filtered.map((group) => {
                                    const marketplaceEntry = marketplaceById.get(group.id)
                                    return (
                                        <PluginCard
                                            key={group.id}
                                            group={group}
                                            marketplaceEntry={marketplaceEntry}
                                            updatePending={marketplacePending?.pluginId === group.id}
                                            t={t}
                                            locale={locale}
                                            onReviewUpdate={marketplaceEntry ? () => reviewMarketplaceUpdate(marketplaceEntry) : undefined}
                                            onUpdate={marketplaceEntry ? () => installMarketplaceUpdate(marketplaceEntry) : undefined}
                                            onClick={() => navigate({
                                                to: '/settings/plugins/$pluginId',
                                                params: { pluginId: group.id },
                                                search: group.primary.target?.scope ? { target: group.primary.target.scope } : {}
                                            })}
                                        />
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
