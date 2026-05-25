import { useMemo, useState } from 'react'
import type { Machine } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CLAUDE_EFFORT_PRESETS, formatClaudeEffortLabel } from '@/lib/claude-effort'
import { useTranslation } from '@/lib/use-translation'
import {
    getPermissionModeLabel,
    getPermissionModeTone,
    getPermissionModesForFlavor,
    type PermissionMode
} from '@hapi/protocol'
import {
    builtinAgentDescriptors,
    type WebSchemaFormOption,
    type WebSchemaFormOptionsSource,
    type AgentCapabilityProviderSnapshot,
    type AgentDescriptor
} from '@hapi/protocol/plugins'

type DescriptorOption = WebSchemaFormOption & {
    count?: number
    lastSeenAt?: number
}
type DescriptorOptionSources = Partial<Record<WebSchemaFormOptionsSource, DescriptorOption[]>>

type PresetScopeMode = 'all' | 'selected'

type SpawnDefaultOptions = {
    model?: string
    permissionMode?: string
    modelReasoningEffort?: string
    effort?: string
}

export type RunnerSpawnDefaultDraft = {
    id: string
    label: string
    enabled: boolean
    agentMode: PresetScopeMode
    agentIds: string[]
    directoryMode: PresetScopeMode
    directoryPrefixes: string[]
    applyToResume: boolean
    defaults: SpawnDefaultOptions
}

type PickerOption = {
    value: string
    label: string
    description?: string
}

type MatchInput = {
    agent?: string
    directory: string
    cwd?: string
    resumeSessionId?: string
}

type MatchResult = {
    matched: RunnerSpawnDefaultDraft[]
    options: SpawnDefaultOptions
}

const KNOWN_CONFIG_KEYS = [
    'agentIds',
    'directoryPrefixes',
    'model',
    'permissionMode',
    'modelReasoningEffort',
    'effort',
    'yolo',
    'applyToResume',
    'rulesJson'
]

const CODEX_REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh']
const CLAUDE_EFFORT_OPTIONS = CLAUDE_EFFORT_PRESETS.map((value) => ({
    value,
    label: formatClaudeEffortLabel(value)
}))

function local(locale: 'en' | 'zh-CN', zh: string, en: string): string {
    return locale === 'zh-CN' ? zh : en
}

function cleanString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function uniqueList(entries: string[]): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
        const value = entry.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        result.push(value)
    }
    return result
}

export function spawnDefaultListFromValue(value: unknown): string[] {
    if (Array.isArray(value)) return uniqueList(value.map((entry) => String(entry)))
    if (typeof value === 'string') return uniqueList(value.split(/[\n,]/))
    return []
}

function normalizeDefaultValue(value: unknown): string | undefined {
    const text = cleanString(value)
    if (!text || text === '__none' || text === 'auto' || text === 'default-auto') return undefined
    return text
}

function hasDefaults(defaults: SpawnDefaultOptions): boolean {
    return Boolean(defaults.model || defaults.permissionMode || defaults.modelReasoningEffort || defaults.effort)
}

function normalizeRule(raw: unknown, fallbackId: string): RunnerSpawnDefaultDraft | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const obj = raw as Record<string, unknown>
    const rawDefaults = obj.defaults && typeof obj.defaults === 'object' && !Array.isArray(obj.defaults)
        ? obj.defaults as Record<string, unknown>
        : obj
    const agentIds = spawnDefaultListFromValue(obj.agentIds)
    const directoryPrefixes = spawnDefaultListFromValue(obj.directoryPrefixes)
    const permissionMode = normalizeDefaultValue(rawDefaults.permissionMode)
        ?? (typeof rawDefaults.yolo === 'boolean' && rawDefaults.yolo ? 'yolo' : undefined)
    return {
        id: cleanString(obj.id) || fallbackId,
        label: cleanString(obj.label) || cleanString(obj.name) || cleanString(obj.id) || fallbackId,
        enabled: obj.enabled !== false,
        agentMode: agentIds.length > 0 ? 'selected' : 'all',
        agentIds,
        directoryMode: directoryPrefixes.length > 0 ? 'selected' : 'all',
        directoryPrefixes,
        applyToResume: obj.applyToResume === true,
        defaults: {
            model: normalizeDefaultValue(rawDefaults.model),
            permissionMode,
            modelReasoningEffort: normalizeDefaultValue(rawDefaults.modelReasoningEffort),
            effort: normalizeDefaultValue(rawDefaults.effort)
        }
    }
}

function flatPresetFromConfig(config: Record<string, unknown>): RunnerSpawnDefaultDraft | null {
    const defaults: SpawnDefaultOptions = {
        model: normalizeDefaultValue(config.model),
        permissionMode: normalizeDefaultValue(config.permissionMode) ?? (config.yolo === true ? 'yolo' : undefined),
        modelReasoningEffort: normalizeDefaultValue(config.modelReasoningEffort),
        effort: normalizeDefaultValue(config.effort)
    }
    if (!hasDefaults(defaults)) return null
    const agentIds = spawnDefaultListFromValue(config.agentIds)
    const directoryPrefixes = spawnDefaultListFromValue(config.directoryPrefixes)
    return {
        id: 'default',
        label: 'Default preset',
        enabled: true,
        agentMode: agentIds.length > 0 ? 'selected' : 'all',
        agentIds,
        directoryMode: directoryPrefixes.length > 0 ? 'selected' : 'all',
        directoryPrefixes,
        applyToResume: config.applyToResume === true,
        defaults
    }
}

export function parseRunnerSpawnDefaultConfig(config: Record<string, unknown>, configKey = 'rulesJson'): { presets: RunnerSpawnDefaultDraft[]; jsonError?: string } {
    const presets: RunnerSpawnDefaultDraft[] = []
    const flat = flatPresetFromConfig(config)
    if (flat) presets.push(flat)

    const rulesJson = cleanString(config[configKey])
    if (!rulesJson) return { presets }
    try {
        const parsed = JSON.parse(rulesJson) as unknown
        if (!Array.isArray(parsed)) return { presets, jsonError: `${configKey} must be a JSON array.` }
        parsed.forEach((rule, index) => {
            const normalized = normalizeRule(rule, `preset-${index + 1}`)
            if (normalized) presets.push(normalized)
        })
        return { presets }
    } catch (error) {
        return { presets, jsonError: error instanceof Error ? error.message : String(error) }
    }
}

function serializePreset(preset: RunnerSpawnDefaultDraft): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    if (preset.defaults.model) defaults.model = preset.defaults.model
    if (preset.defaults.permissionMode) defaults.permissionMode = preset.defaults.permissionMode
    if (preset.defaults.modelReasoningEffort) defaults.modelReasoningEffort = preset.defaults.modelReasoningEffort
    if (preset.defaults.effort) defaults.effort = preset.defaults.effort

    return {
        id: preset.id,
        label: preset.label.trim() || preset.id,
        enabled: preset.enabled,
        ...(preset.applyToResume ? { applyToResume: true } : {}),
        ...(preset.agentMode === 'selected' ? { agentIds: preset.agentIds } : {}),
        ...(preset.directoryMode === 'selected' ? { directoryPrefixes: preset.directoryPrefixes } : {}),
        defaults
    }
}

export function serializeRunnerSpawnDefaultConfig(presets: RunnerSpawnDefaultDraft[], baseConfig: Record<string, unknown> = {}, configKey = 'rulesJson'): Record<string, unknown> {
    const next: Record<string, unknown> = { ...baseConfig }
    for (const key of KNOWN_CONFIG_KEYS) delete next[key]
    delete next[configKey]
    const serializable = presets.map(serializePreset)
    if (serializable.length > 0) {
        next[configKey] = JSON.stringify(serializable, null, 2)
    }
    return next
}

function normalizePath(value: string | undefined): string {
    if (!value) return ''
    let normalized = value.trim().replace(/\\/g, '/')
    while (normalized.includes('//')) normalized = normalized.replaceAll('//', '/')
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
}

function pathMatchesPrefix(actual: string | undefined, prefix: string): boolean {
    const path = normalizePath(actual)
    const base = normalizePath(prefix)
    if (!path || !base) return false
    if (base === '/' || (base.length === 3 && base[1] === ':' && base[2] === '/' && /^[A-Za-z]$/.test(base[0]))) {
        return path.startsWith(base)
    }
    return path === base || path.startsWith(`${base}/`)
}

function presetMatches(preset: RunnerSpawnDefaultDraft, input: MatchInput): boolean {
    if (!preset.enabled) return false
    if (input.resumeSessionId && !preset.applyToResume) return false
    if (preset.agentMode === 'selected' && preset.agentIds.length > 0 && (!input.agent || !preset.agentIds.includes(input.agent))) return false
    if (preset.directoryMode === 'selected' && preset.directoryPrefixes.length > 0) {
        return preset.directoryPrefixes.some((prefix) => pathMatchesPrefix(input.cwd, prefix) || pathMatchesPrefix(input.directory, prefix))
    }
    return true
}

function specificity(preset: RunnerSpawnDefaultDraft): number {
    const agentScore = preset.agentMode === 'selected' && preset.agentIds.length > 0 ? 100000 : 0
    const pathScore = preset.directoryMode === 'selected'
        ? preset.directoryPrefixes.reduce((max, prefix) => Math.max(max, normalizePath(prefix).length), 0)
        : 0
    return agentScore + pathScore
}

export function resolveRunnerSpawnDefaultDrafts(presets: RunnerSpawnDefaultDraft[], input: MatchInput): MatchResult {
    const matched = presets
        .filter((preset) => presetMatches(preset, input))
        .sort((left, right) => specificity(left) - specificity(right))
    const options: SpawnDefaultOptions = {}
    for (const preset of matched) {
        if (preset.defaults.model) options.model = preset.defaults.model
        if (preset.defaults.permissionMode) options.permissionMode = preset.defaults.permissionMode
        if (preset.defaults.modelReasoningEffort) options.modelReasoningEffort = preset.defaults.modelReasoningEffort
        if (preset.defaults.effort) options.effort = preset.defaults.effort
    }
    return { matched, options }
}

function nextPresetId(presets: RunnerSpawnDefaultDraft[]): string {
    const used = new Set(presets.map((preset) => preset.id))
    for (let index = presets.length + 1; index < presets.length + 1000; index += 1) {
        const candidate = `preset-${index}`
        if (!used.has(candidate)) return candidate
    }
    return `preset-${Date.now()}`
}

function fallbackPreset(presets: RunnerSpawnDefaultDraft[], firstAgentId?: string, firstWorkspace?: string): RunnerSpawnDefaultDraft {
    const id = nextPresetId(presets)
    return {
        id,
        label: 'New preset',
        enabled: true,
        agentMode: 'all',
        agentIds: firstAgentId ? [firstAgentId] : [],
        directoryMode: 'all',
        directoryPrefixes: firstWorkspace ? [firstWorkspace] : [],
        applyToResume: false,
        defaults: {}
    }
}

function agentDescriptorsForMachine(machine: Machine | null): AgentDescriptor[] {
    const descriptors = machine?.runnerState?.agentDescriptors
    const source = descriptors && descriptors.length > 0 ? descriptors : builtinAgentDescriptors()
    return source.filter((descriptor) => descriptor.available !== false)
}

function displayAgent(agent: AgentDescriptor): PickerOption {
    return {
        value: agent.id,
        label: agent.displayName || agent.id,
        description: agent.description
    }
}

function uniqueOptions(options: PickerOption[]): PickerOption[] {
    const result: PickerOption[] = []
    const seen = new Set<string>()
    for (const option of options) {
        const value = option.value.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        result.push({ ...option, value })
    }
    return result
}

function workspaceOptions(machine: Machine | null, optionSources?: DescriptorOptionSources): PickerOption[] {
    const rootOptions = (machine?.metadata?.workspaceRoots ?? []).map((path) => ({ value: path, label: path }))
    const recentOptions = [
        ...(optionSources?.['runner.workspaces'] ?? []),
        ...(optionSources?.['sessions.workspaces'] ?? []),
        ...(optionSources?.['notification.workspaces'] ?? [])
    ].map((option) => ({
        value: option.value,
        label: typeof option.label === 'string' ? option.label : option.value,
        description: option.description ? (typeof option.description === 'string' ? option.description : undefined) : undefined
    }))
    return uniqueOptions([...rootOptions, ...recentOptions])
}

function modelOptionsForAgents(agentIds: string[], descriptors: AgentDescriptor[], snapshots: AgentCapabilityProviderSnapshot[]): PickerOption[] {
    const target = new Set(agentIds)
    const options: PickerOption[] = []
    for (const descriptor of descriptors) {
        if (!target.has(descriptor.id)) continue
        for (const model of descriptor.capabilities.models ?? []) {
            options.push({ value: model, label: model, description: descriptor.displayName })
        }
    }
    for (const snapshot of snapshots) {
        if (!target.has(snapshot.agentId)) continue
        for (const model of snapshot.capabilities.models ?? []) {
            options.push({
                value: model.id,
                label: model.displayName ?? model.id,
                description: model.description ?? snapshot.agentId
            })
        }
    }
    return uniqueOptions(options)
}

function permissionModesForAgent(agentId: string, descriptors: AgentDescriptor[], snapshots: AgentCapabilityProviderSnapshot[]): PermissionMode[] {
    const fromCapabilities = snapshots
        .filter((snapshot) => snapshot.agentId === agentId)
        .flatMap((snapshot) => snapshot.capabilities.permissionModes ?? [])
        .map((entry) => entry.mode)
    if (fromCapabilities.length > 0) return uniqueList(fromCapabilities) as PermissionMode[]
    const descriptorModes = descriptors.find((descriptor) => descriptor.id === agentId)?.capabilities.permissionModes
    if (descriptorModes && descriptorModes.length > 0) return [...descriptorModes]
    return [...getPermissionModesForFlavor(agentId)]
}

export function commonPermissionModesForAgents(agentIds: string[], descriptors: AgentDescriptor[], snapshots: AgentCapabilityProviderSnapshot[]): PermissionMode[] {
    if (agentIds.length === 0) return []
    const [first, ...rest] = agentIds.map((agentId) => permissionModesForAgent(agentId, descriptors, snapshots))
    if (!first) return []
    return first.filter((mode) => rest.every((modes) => modes.includes(mode)))
}

function modeDescription(mode: PermissionMode, locale: 'en' | 'zh-CN'): string {
    if (mode === 'default') return local(locale, '使用该 Agent 的默认权限策略', 'Use the agent default permission policy')
    if (mode === 'acceptEdits') return local(locale, '自动接受编辑，仍保留其他确认', 'Accept edits automatically while keeping other prompts')
    if (mode === 'bypassPermissions' || mode === 'yolo') return local(locale, '跳过确认，风险较高', 'Bypass confirmations; higher risk')
    if (mode === 'safe-yolo') return local(locale, '更安全的自动执行模式', 'Safer automatic execution mode')
    if (mode === 'read-only') return local(locale, '只读 / 不写入', 'Read-only / no writes')
    if (mode === 'plan') return local(locale, '规划模式', 'Planning mode')
    if (mode === 'ask') return local(locale, '操作前询问', 'Ask before acting')
    return mode
}

function targetAgentIds(preset: RunnerSpawnDefaultDraft, descriptors: AgentDescriptor[]): string[] {
    if (preset.agentMode === 'selected') return preset.agentIds.filter((id) => descriptors.some((descriptor) => descriptor.id === id))
    return descriptors.map((descriptor) => descriptor.id)
}

function supportsClaudeEffort(agentIds: string[]): boolean {
    return agentIds.includes('claude')
}

function supportsCodexReasoning(agentIds: string[]): boolean {
    return agentIds.includes('codex')
}

function defaultsSummary(defaults: SpawnDefaultOptions, locale: 'en' | 'zh-CN'): string[] {
    const entries: string[] = []
    if (defaults.model) entries.push(`model=${defaults.model}`)
    if (defaults.permissionMode) entries.push(`${local(locale, '权限', 'permission')}=${defaults.permissionMode}`)
    if (defaults.modelReasoningEffort) entries.push(`reasoning=${defaults.modelReasoningEffort}`)
    if (defaults.effort) entries.push(`effort=${defaults.effort}`)
    return entries
}

function ChipMultiPicker(props: {
    label: string
    values: string[]
    options: PickerOption[]
    placeholder: string
    addLabel: string
    disabled?: boolean
    allowCustom?: boolean
    onChange: (values: string[]) => void
}) {
    const [query, setQuery] = useState('')
    const selected = new Set(props.values)
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = props.options
        .filter((option) => !selected.has(option.value))
        .filter((option) => !normalizedQuery || option.value.toLowerCase().includes(normalizedQuery) || option.label.toLowerCase().includes(normalizedQuery))
        .slice(0, 8)
    const add = (value: string) => {
        if (!value.trim()) return
        props.onChange(uniqueList([...props.values, value]))
        setQuery('')
    }
    const remove = (value: string) => props.onChange(props.values.filter((entry) => entry !== value))
    const addCustom = () => {
        const values = spawnDefaultListFromValue(query)
        if (values.length === 0) return
        props.onChange(uniqueList([...props.values, ...values]))
        setQuery('')
    }
    return (
        <div className="space-y-2">
            <div className="text-sm font-medium">{props.label}</div>
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2">
                <div className="flex min-w-0 flex-wrap gap-1.5">
                    {props.values.length === 0 ? <span className="px-1 py-1 text-xs text-[var(--app-hint)]">{props.placeholder}</span> : null}
                    {props.values.map((value) => {
                        const label = props.options.find((option) => option.value === value)?.label ?? value
                        return (
                            <button
                                key={value}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => remove(value)}
                                className="max-w-full rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-left text-xs disabled:opacity-60"
                                title={value}
                            >
                                <span className="break-all">{label}</span> <span className="text-[var(--app-hint)]">×</span>
                            </button>
                        )
                    })}
                </div>
                <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input
                        value={query}
                        disabled={props.disabled}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault()
                                if (filtered[0] && !props.allowCustom) add(filtered[0].value)
                                else addCustom()
                            }
                        }}
                        placeholder={props.placeholder}
                        className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                    />
                    {props.allowCustom !== false ? (
                        <Button type="button" size="sm" variant="outline" disabled={props.disabled || spawnDefaultListFromValue(query).length === 0} onClick={addCustom}>
                            {props.addLabel}
                        </Button>
                    ) : null}
                </div>
                {filtered.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {filtered.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                disabled={props.disabled}
                                onClick={() => add(option.value)}
                                className="max-w-full rounded-full bg-[var(--app-bg)] px-2 py-1 text-left text-xs hover:bg-[var(--app-secondary-bg)] disabled:opacity-60"
                                title={option.value}
                            >
                                <span className="break-all font-medium">{option.label}</span>
                                {option.description ? <span className="ml-1 text-[var(--app-hint)]">{option.description}</span> : null}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function ScopeSwitch(props: {
    value: PresetScopeMode
    allLabel: string
    selectedLabel: string
    disabled?: boolean
    onChange: (value: PresetScopeMode) => void
}) {
    return (
        <div className="inline-flex rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-1 text-xs">
            {([
                ['all', props.allLabel],
                ['selected', props.selectedLabel]
            ] as const).map(([value, label]) => (
                <button
                    key={value}
                    type="button"
                    disabled={props.disabled}
                    onClick={() => props.onChange(value)}
                    className={`rounded-md px-2.5 py-1.5 font-medium ${props.value === value ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}
                >
                    {label}
                </button>
            ))}
        </div>
    )
}

function SelectField(props: {
    label: string
    value?: string
    options: Array<{ value: string; label: string; description?: string; tone?: string }>
    placeholder: string
    disabled?: boolean
    onChange: (value: string | undefined) => void
}) {
    const selected = props.options.find((option) => option.value === props.value)
    return (
        <label className="block space-y-1 text-sm">
            <span className="block font-medium">{props.label}</span>
            <select
                value={props.value ?? ''}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.value || undefined)}
                className="w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
            >
                <option value="">{props.placeholder}</option>
                {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {selected?.description ? <span className="block text-xs text-[var(--app-hint)]">{selected.description}</span> : null}
        </label>
    )
}

function PresetEditorCard(props: {
    preset: RunnerSpawnDefaultDraft
    descriptors: AgentDescriptor[]
    snapshots: AgentCapabilityProviderSnapshot[]
    workspaceOptions: PickerOption[]
    locale: 'en' | 'zh-CN'
    disabled?: boolean
    expanded: boolean
    onToggleExpanded: () => void
    onUpdate: (preset: RunnerSpawnDefaultDraft) => void
    onDelete: () => void
    onDuplicate: () => void
}) {
    const agentOptions = props.descriptors.map(displayAgent)
    const activeAgentIds = targetAgentIds(props.preset, props.descriptors)
    const modelOptions = modelOptionsForAgents(activeAgentIds, props.descriptors, props.snapshots)
    const permissionModes = commonPermissionModesForAgents(activeAgentIds, props.descriptors, props.snapshots)
    const permissionOptions: Array<{ value: string; label: string; description?: string; tone?: string }> = permissionModes.map((mode) => ({
        value: mode,
        label: getPermissionModeLabel(mode),
        description: modeDescription(mode, props.locale),
        tone: getPermissionModeTone(mode)
    }))
    if (props.preset.defaults.permissionMode && !permissionOptions.some((option) => option.value === props.preset.defaults.permissionMode)) {
        permissionOptions.push({
            value: props.preset.defaults.permissionMode,
            label: `${props.preset.defaults.permissionMode} · ${local(props.locale, '当前 Agent 不支持', 'unsupported for selected agents')}`,
            description: local(props.locale, '当前 Agent 范围不支持该权限模式；建议重新选择。', 'This permission mode is not supported by the current agent scope.'),
            tone: 'warning'
        })
    }
    const showCodexReasoning = supportsCodexReasoning(activeAgentIds) || Boolean(props.preset.defaults.modelReasoningEffort)
    const showClaudeEffort = supportsClaudeEffort(activeAgentIds) || Boolean(props.preset.defaults.effort)
    const summary = defaultsSummary(props.preset.defaults, props.locale)
    const agentScopeLabel = props.preset.agentMode === 'all'
        ? local(props.locale, '所有可用 Agent', 'All available agents')
        : props.preset.agentIds.map((id) => agentOptions.find((option) => option.value === id)?.label ?? id).join(', ')
    const workspaceScopeLabel = props.preset.directoryMode === 'all'
        ? local(props.locale, '所有工作区', 'All workspaces')
        : props.preset.directoryPrefixes.join(', ')

    const updateDefaults = (defaults: Partial<SpawnDefaultOptions>) => props.onUpdate({
        ...props.preset,
        defaults: { ...props.preset.defaults, ...defaults }
    })

    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={props.onToggleExpanded}>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate font-semibold">{props.preset.label || props.preset.id}</span>
                        <Badge variant={props.preset.enabled ? 'success' : 'default'}>{props.preset.enabled ? local(props.locale, '已启用', 'Enabled') : local(props.locale, '已停用', 'Disabled')}</Badge>
                        {summary.length === 0 ? <Badge variant="warning">{local(props.locale, '未设置默认值', 'No defaults')}</Badge> : null}
                    </div>
                    <div className="mt-1 min-w-0 break-words text-xs text-[var(--app-hint)]">
                        {agentScopeLabel || local(props.locale, '未选择 Agent', 'No agents')} · {workspaceScopeLabel || local(props.locale, '未选择工作区', 'No workspaces')}
                    </div>
                    {summary.length > 0 ? <div className="mt-2 flex flex-wrap gap-1.5">{summary.map((entry) => <Badge key={entry}>{entry}</Badge>)}</div> : null}
                </button>
                <div className="flex gap-1">
                    <Button type="button" size="sm" variant="outline" disabled={props.disabled} onClick={props.onToggleExpanded}>{props.expanded ? local(props.locale, '收起', 'Collapse') : local(props.locale, '编辑', 'Edit')}</Button>
                    <Button type="button" size="sm" variant="outline" disabled={props.disabled} onClick={props.onDuplicate}>{local(props.locale, '复制', 'Duplicate')}</Button>
                    <Button type="button" size="sm" variant="outline" disabled={props.disabled} onClick={props.onDelete}>{local(props.locale, '删除', 'Delete')}</Button>
                </div>
            </div>

            {props.expanded ? (
                <div className="mt-4 space-y-4 border-t border-[var(--app-border)] pt-4">
                    <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                        <label className="block space-y-1 text-sm">
                            <span className="font-medium">{local(props.locale, '名称', 'Name')}</span>
                            <input
                                value={props.preset.label}
                                disabled={props.disabled}
                                onChange={(event) => props.onUpdate({ ...props.preset, label: event.target.value })}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            />
                        </label>
                        <label className="flex items-center gap-2 self-end rounded-md border border-[var(--app-border)] px-3 py-2 text-sm">
                            <input
                                type="checkbox"
                                checked={props.preset.enabled}
                                disabled={props.disabled}
                                onChange={(event) => props.onUpdate({ ...props.preset, enabled: event.target.checked })}
                                className="accent-[var(--app-link)]"
                            />
                            {local(props.locale, '启用', 'Enabled')}
                        </label>
                    </div>

                    <div className="space-y-3 rounded-lg bg-[var(--app-subtle-bg)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <div className="text-sm font-semibold">{local(props.locale, '如果', 'If')}</div>
                                <div className="text-xs text-[var(--app-hint)]">{local(props.locale, '空范围通过“全部”模式表达，不会把所有值硬编码进配置。', 'The All mode is stored as an empty scope, not as every value copied into config.')}</div>
                            </div>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={props.preset.applyToResume}
                                    disabled={props.disabled}
                                    onChange={(event) => props.onUpdate({ ...props.preset, applyToResume: event.target.checked })}
                                    className="accent-[var(--app-link)]"
                                />
                                {local(props.locale, '也应用到恢复会话', 'Also apply to resumed sessions')}
                            </label>
                        </div>
                        <div className="space-y-2">
                            <ScopeSwitch
                                value={props.preset.agentMode}
                                allLabel={local(props.locale, '所有可用 Agent', 'All available agents')}
                                selectedLabel={local(props.locale, '指定 Agent', 'Selected agents')}
                                disabled={props.disabled}
                                onChange={(value) => props.onUpdate({
                                    ...props.preset,
                                    agentMode: value,
                                    agentIds: value === 'selected' && props.preset.agentIds.length === 0 && props.descriptors[0] ? [props.descriptors[0].id] : props.preset.agentIds
                                })}
                            />
                            {props.preset.agentMode === 'selected' ? (
                                <ChipMultiPicker
                                    label={local(props.locale, 'Agent', 'Agents')}
                                    values={props.preset.agentIds}
                                    options={agentOptions}
                                    placeholder={local(props.locale, '搜索并选择 Agent', 'Search and select agents')}
                                    addLabel={local(props.locale, '添加', 'Add')}
                                    disabled={props.disabled}
                                    allowCustom={false}
                                    onChange={(agentIds) => props.onUpdate({ ...props.preset, agentIds })}
                                />
                            ) : null}
                        </div>
                        <div className="space-y-2">
                            <ScopeSwitch
                                value={props.preset.directoryMode}
                                allLabel={local(props.locale, '所有工作区', 'All workspaces')}
                                selectedLabel={local(props.locale, '指定工作区前缀', 'Selected workspace prefixes')}
                                disabled={props.disabled}
                                onChange={(value) => props.onUpdate({
                                    ...props.preset,
                                    directoryMode: value,
                                    directoryPrefixes: value === 'selected' && props.preset.directoryPrefixes.length === 0 && props.workspaceOptions[0] ? [props.workspaceOptions[0].value] : props.preset.directoryPrefixes
                                })}
                            />
                            {props.preset.directoryMode === 'selected' ? (
                                <ChipMultiPicker
                                    label={local(props.locale, '工作区前缀', 'Workspace prefixes')}
                                    values={props.preset.directoryPrefixes}
                                    options={props.workspaceOptions}
                                    placeholder={local(props.locale, '搜索最近工作区，或输入路径', 'Search recent workspaces, or type a path')}
                                    addLabel={local(props.locale, '添加', 'Add')}
                                    disabled={props.disabled}
                                    onChange={(directoryPrefixes) => props.onUpdate({ ...props.preset, directoryPrefixes })}
                                />
                            ) : null}
                        </div>
                    </div>

                    <div className="space-y-3 rounded-lg bg-[var(--app-subtle-bg)] p-3">
                        <div>
                            <div className="text-sm font-semibold">{local(props.locale, '则默认使用', 'Then default to')}</div>
                            <div className="text-xs text-[var(--app-hint)]">{local(props.locale, '只设置用户没有手动选择的字段。权限模式按当前 Agent 范围自动取交集。', 'Only unset user fields are applied. Permission modes are filtered by the selected agent scope.')}</div>
                        </div>
                        <label className="block space-y-1 text-sm">
                            <span className="font-medium">{local(props.locale, '模型', 'Model')}</span>
                            <input
                                value={props.preset.defaults.model ?? ''}
                                disabled={props.disabled}
                                list={`models-${props.preset.id}`}
                                placeholder={modelOptions.length > 0 ? local(props.locale, '选择或输入模型；留空不设置', 'Choose or type a model; blank means no default') : local(props.locale, '输入自定义模型；留空不设置', 'Type a custom model; blank means no default')}
                                onChange={(event) => updateDefaults({ model: event.target.value.trim() || undefined })}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                            />
                            <datalist id={`models-${props.preset.id}`}>
                                {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </datalist>
                            {props.preset.agentMode === 'all' ? <span className="block text-xs text-[var(--app-hint)]">{local(props.locale, '全部 Agent 模式下请确保模型对目标 Agent 兼容。', 'In All agents mode, ensure the model is compatible with target agents.')}</span> : null}
                        </label>
                        <SelectField
                            label={local(props.locale, '权限模式', 'Permission mode')}
                            value={props.preset.defaults.permissionMode}
                            options={permissionOptions}
                            placeholder={local(props.locale, '不设置权限默认值', 'No permission default')}
                            disabled={props.disabled || permissionOptions.length === 0}
                            onChange={(permissionMode) => updateDefaults({ permissionMode })}
                        />
                        {permissionOptions.length === 0 ? <div className="text-xs text-[var(--app-hint)]">{local(props.locale, '当前 Agent 范围没有可共同使用的权限模式。', 'The current agent scope has no common permission modes.')}</div> : null}
                        {showCodexReasoning ? (
                            <SelectField
                                label={local(props.locale, 'Codex 思考强度', 'Codex reasoning effort')}
                                value={props.preset.defaults.modelReasoningEffort}
                                options={CODEX_REASONING_OPTIONS.map((value) => ({ value, label: value }))}
                                placeholder={local(props.locale, '不设置', 'No default')}
                                disabled={props.disabled}
                                onChange={(modelReasoningEffort) => updateDefaults({ modelReasoningEffort })}
                            />
                        ) : null}
                        {showClaudeEffort ? (
                            <SelectField
                                label={local(props.locale, 'Claude effort', 'Claude effort')}
                                value={props.preset.defaults.effort}
                                options={CLAUDE_EFFORT_OPTIONS}
                                placeholder={local(props.locale, '不设置', 'No default')}
                                disabled={props.disabled}
                                onChange={(effort) => updateDefaults({ effort })}
                            />
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    )
}

function TestMatchPanel(props: {
    presets: RunnerSpawnDefaultDraft[]
    descriptors: AgentDescriptor[]
    workspaceOptions: PickerOption[]
    locale: 'en' | 'zh-CN'
}) {
    const [agent, setAgent] = useState(props.descriptors[0]?.id ?? 'codex')
    const [directory, setDirectory] = useState(props.workspaceOptions[0]?.value ?? '')
    const [resume, setResume] = useState(false)
    const result = useMemo(() => resolveRunnerSpawnDefaultDrafts(props.presets, {
        agent,
        directory: directory || '/',
        cwd: directory || '/',
        ...(resume ? { resumeSessionId: 'preview' } : {})
    }), [agent, directory, props.presets, resume])
    const applied = defaultsSummary(result.options, props.locale)
    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="font-semibold">{local(props.locale, '测试匹配', 'Test matching')}</div>
                    <div className="text-xs text-[var(--app-hint)]">{local(props.locale, '基于当前未保存草稿即时计算。', 'Calculated from the current unsaved draft.')}</div>
                </div>
                <Badge>{result.matched.length > 0 ? local(props.locale, '已匹配', 'Matched') : local(props.locale, '无匹配', 'No match')}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1 text-sm">
                    <span className="font-medium">Agent</span>
                    <select value={agent} onChange={(event) => setAgent(event.target.value)} className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]">
                        {props.descriptors.map((descriptor) => <option key={descriptor.id} value={descriptor.id}>{descriptor.displayName}</option>)}
                    </select>
                </label>
                <label className="block space-y-1 text-sm">
                    <span className="font-medium">{local(props.locale, '工作区', 'Workspace')}</span>
                    <input value={directory} list="spawn-default-test-workspaces" onChange={(event) => setDirectory(event.target.value)} className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]" />
                    <datalist id="spawn-default-test-workspaces">
                        {props.workspaceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </datalist>
                </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={resume} onChange={(event) => setResume(event.target.checked)} className="accent-[var(--app-link)]" />
                {local(props.locale, '按恢复会话测试', 'Test as resumed session')}
            </label>
            <div className="mt-3 space-y-2 rounded-lg bg-[var(--app-subtle-bg)] p-3 text-sm">
                <div className="font-medium">{local(props.locale, '匹配顺序', 'Match order')}</div>
                {result.matched.length === 0 ? <div className="text-[var(--app-hint)]">{local(props.locale, '没有默认值会应用。', 'No presets would apply.')}</div> : (
                    <ol className="list-inside list-decimal space-y-1">
                        {result.matched.map((preset) => <li key={preset.id}>{preset.label || preset.id}</li>)}
                    </ol>
                )}
                <div className="font-medium">{local(props.locale, '最终默认值', 'Final defaults')}</div>
                {applied.length === 0 ? <div className="text-[var(--app-hint)]">{local(props.locale, '无默认值。', 'No defaults.')}</div> : <div className="flex flex-wrap gap-1.5">{applied.map((entry) => <Badge key={entry}>{entry}</Badge>)}</div>}
            </div>
        </div>
    )
}

export function RunnerSpawnDefaultsEditor(props: {
    config: Record<string, unknown>
    machines: Machine[]
    targetMachineId?: string | null
    optionSources?: DescriptorOptionSources
    dirty?: boolean
    disabled?: boolean
    configKey?: string
    onConfigChange: (config: Record<string, unknown>) => void
}) {
    const { locale } = useTranslation()
    const machine = useMemo(() => {
        if (props.targetMachineId) {
            return props.machines.find((entry) => entry.id === props.targetMachineId) ?? null
        }
        return props.machines[0] ?? null
    }, [props.machines, props.targetMachineId])
    const descriptors = useMemo(() => agentDescriptorsForMachine(machine), [machine])
    const snapshots = useMemo(() => machine?.runnerState?.agentCapabilities ?? [], [machine])
    const workspaces = useMemo(() => workspaceOptions(machine, props.optionSources), [machine, props.optionSources])
    const configKey = props.configKey ?? 'rulesJson'
    const parsed = useMemo(() => parseRunnerSpawnDefaultConfig(props.config, configKey), [props.config, configKey])
    const starterPreset = useMemo(
        () => fallbackPreset([], descriptors[0]?.id, workspaces[0]?.value),
        [descriptors, workspaces]
    )
    const visiblePresets = parsed.presets.length > 0 ? parsed.presets : [starterPreset]
    const [expandedId, setExpandedId] = useState<string | null>(parsed.presets[0]?.id ?? starterPreset.id)
    const activeExpandedId = expandedId ?? (parsed.presets.length === 0 ? starterPreset.id : null)

    const commit = (presets: RunnerSpawnDefaultDraft[]) => {
        props.onConfigChange(serializeRunnerSpawnDefaultConfig(presets, props.config, configKey))
    }
    const updatePreset = (preset: RunnerSpawnDefaultDraft) => {
        if (parsed.presets.length === 0) {
            commit([preset])
            setExpandedId(preset.id)
            return
        }
        commit(parsed.presets.map((entry) => entry.id === preset.id ? preset : entry))
    }
    const addPreset = () => {
        const basePresets = parsed.presets.length > 0 ? parsed.presets : [starterPreset]
        const next = fallbackPreset(basePresets, descriptors[0]?.id, workspaces[0]?.value)
        commit([...basePresets, next])
        setExpandedId(next.id)
    }
    const duplicatePreset = (preset: RunnerSpawnDefaultDraft) => {
        const basePresets = parsed.presets.length > 0 ? parsed.presets : [starterPreset]
        const id = nextPresetId(basePresets)
        const copy = { ...preset, id, label: `${preset.label || preset.id} copy` }
        commit([...basePresets, copy])
        setExpandedId(id)
    }

    return (
        <div className="min-w-0 space-y-3">
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold">{local(locale, 'Runner 启动默认值', 'Runner spawn defaults')}</h3>
                            {props.dirty ? <Badge variant="warning">{local(locale, '未保存', 'Unsaved')}</Badge> : <Badge variant="success">{local(locale, '已保存', 'Saved')}</Badge>}
                        </div>
                        <div className="mt-1 text-sm text-[var(--app-hint)]">
                            {local(locale, '用可视化规则设置默认模型、权限和思考强度；右上角保存并重载后生效。', 'Use visual rules to set default model, permission mode, and reasoning; save and reload from the top-right to apply.')}
                        </div>
                        {machine ? <div className="mt-1 text-xs text-[var(--app-hint)]">{local(locale, '目标 Runner', 'Target runner')}: {machine.metadata?.displayName ?? machine.id}</div> : null}
                    </div>
                    <Button type="button" size="sm" disabled={props.disabled} onClick={addPreset}>+ {local(locale, '新建默认值', 'New preset')}</Button>
                </div>
                {parsed.jsonError ? <div className="mt-3 rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2 text-sm text-[var(--app-badge-warning-text)]">{configKey}: {parsed.jsonError}</div> : null}
            </div>

            <div className="space-y-3">
                {parsed.presets.length === 0 ? (
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        {local(locale, '当前还没有已保存默认值；下方已展开第一条默认值草稿，填写任意默认值后右上角保存并重载即可生效。', 'No saved presets yet; the first preset draft is expanded below. Set any default and save/reload from the top-right to apply.')}
                    </div>
                ) : null}
                {visiblePresets.map((preset) => (
                    <PresetEditorCard
                        key={preset.id}
                        preset={preset}
                        descriptors={descriptors}
                        snapshots={snapshots}
                        workspaceOptions={workspaces}
                        locale={locale}
                        disabled={props.disabled}
                        expanded={activeExpandedId === preset.id}
                        onToggleExpanded={() => setExpandedId(activeExpandedId === preset.id ? null : preset.id)}
                        onUpdate={updatePreset}
                        onDelete={() => {
                            commit(parsed.presets.filter((entry) => entry.id !== preset.id))
                            if (expandedId === preset.id) setExpandedId(null)
                        }}
                        onDuplicate={() => duplicatePreset(preset)}
                    />
                ))}
            </div>

            <TestMatchPanel presets={visiblePresets} descriptors={descriptors} workspaceOptions={workspaces} locale={locale} />
        </div>
    )
}
