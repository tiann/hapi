import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Machine } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'
import { RunnerSpawnDefaultsEditor } from './RunnerSpawnDefaultsEditor'
import {
    CorePluginActionIdSchema,
    WebDescriptorComponentSchema,
    WebLocalizedTextSchema,
    localizeWebText,
    type CorePluginActionId,
    type WebDescriptorComponent,
    type WebLocalizedText,
    type WebSchemaFormOption,
    type WebSchemaFormOptionsSource,
    type WebSchemaFormField,
} from '@hapi/protocol/plugins'

export type DescriptorActionHandler = (actionId: CorePluginActionId) => Promise<void> | void
export type DescriptorConfigSaveHandler = (config: Record<string, unknown>) => Promise<void> | void
export type DescriptorConfigChangeHandler = (config: Record<string, unknown>) => void
export type DescriptorOption = WebSchemaFormOption & {
    count?: number
    lastSeenAt?: number
}
export type DescriptorOptionSources = Partial<Record<WebSchemaFormOptionsSource, DescriptorOption[]>>

type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive'

type DescriptorBoundaryProps = {
    children: ReactNode
    fallback: ReactNode
}

type DescriptorBoundaryState = {
    error: Error | null
}

export class DescriptorBoundary extends React.Component<DescriptorBoundaryProps, DescriptorBoundaryState> {
    state: DescriptorBoundaryState = { error: null }

    static getDerivedStateFromError(error: Error): DescriptorBoundaryState {
        return { error }
    }

    render(): ReactNode {
        if (this.state.error) {
            return this.props.fallback
        }
        return this.props.children
    }
}

export function descriptorText(value: WebLocalizedText | undefined, locale = navigator.language || 'en'): string {
    if (!value) return ''
    return localizeWebText(value, locale)
}

function badgeVariant(variant?: string): BadgeVariant {
    if (variant === 'danger') return 'destructive'
    if (variant === 'success' || variant === 'warning') return variant
    return 'default'
}

function componentKey(component: WebDescriptorComponent, index: number): string {
    return component.id ?? `${component.kind}-${index}`
}

function valueIsBlank(value: unknown): boolean {
    if (Array.isArray(value)) return value.length === 0
    return value === undefined || value === null || value === ''
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

function listFromValue(value: unknown): string[] {
    if (Array.isArray(value)) {
        return uniqueList(value.map((entry) => String(entry)))
    }
    if (typeof value === 'string') {
        return uniqueList(value.split(/[\n,]/))
    }
    return []
}

function initialFieldValue(field: WebSchemaFormField, config: Record<string, unknown>): unknown {
    if (field.secret) return ''
    const current = config[field.key]
    if (field.type === 'multiSelect') {
        if (current !== undefined && current !== '[REDACTED]') return listFromValue(current)
        return []
    }
    if (current !== undefined && current !== '[REDACTED]') return current
    if (field.defaultValue !== undefined) return field.defaultValue
    if (field.type === 'boolean') return false
    return ''
}

function coerceFieldValue(field: WebSchemaFormField, value: unknown): unknown {
    if (field.type === 'boolean') return value === true
    if (field.type === 'multiSelect') {
        const values = listFromValue(value)
        return values.length > 0 ? values : undefined
    }
    if (field.type === 'number') {
        if (valueIsBlank(value)) return undefined
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : value
    }
    if (typeof value === 'string') return value
    return value ?? ''
}

function buildNextConfig(fields: WebSchemaFormField[], config: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
    const nextConfig = { ...config }
    for (const field of fields) {
        if (field.secret) continue
        const value = coerceFieldValue(field, values[field.key])
        if (value === undefined || value === '') {
            delete nextConfig[field.key]
        } else {
            nextConfig[field.key] = value
        }
    }
    return nextConfig
}

function fieldWantsMultilineText(field: WebSchemaFormField): boolean {
    return field.type === 'text' && /json|yaml|toml|script|template/i.test(field.key)
}

function optionsForField(field: WebSchemaFormField, optionSources?: DescriptorOptionSources): DescriptorOption[] {
    const sourceOptions = field.optionsSource ? optionSources?.[field.optionsSource] ?? [] : []
    const entries = [...sourceOptions, ...(field.options ?? [])]
    const result: DescriptorOption[] = []
    const seen = new Set<string>()
    for (const option of entries) {
        const value = option.value.trim()
        if (!value || seen.has(value)) continue
        seen.add(value)
        result.push({ ...option, value })
    }
    return result
}

function SchemaMultiSelectField(props: {
    field: WebSchemaFormField
    value: unknown
    options: DescriptorOption[]
    sourceReady: boolean
    disabled?: boolean
    saving?: boolean
    onChange: (value: string[]) => void
}) {
    const { t, locale } = useTranslation()
    const [customValue, setCustomValue] = useState('')
    const selected = listFromValue(props.value)
    const selectedSet = new Set(selected)
    const optionsByValue = new Map(props.options.map((option) => [option.value, option]))
    const options: DescriptorOption[] = [
        ...props.options,
        ...selected
            .filter((value) => !optionsByValue.has(value))
            .map((value): DescriptorOption => ({ value }))
    ]
    const disabled = props.disabled || props.saving

    const setSelected = (next: string[]) => props.onChange(uniqueList(next))
    const toggleValue = (value: string, checked: boolean) => {
        setSelected(checked
            ? [...selected, value]
            : selected.filter((entry) => entry !== value))
    }
    const addCustomValue = () => {
        const entries = listFromValue(customValue)
        if (entries.length === 0) return
        setSelected([...selected, ...entries])
        setCustomValue('')
    }

    return (
        <div className="space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2">
            <div className="text-xs text-[var(--app-hint)]">{t('settings.plugins.descriptor.allWhenEmpty')}</div>
            {!props.sourceReady ? <div className="text-xs text-[var(--app-hint)]">{t('settings.plugins.descriptor.loadingOptions')}</div> : null}
            {props.sourceReady && options.length === 0 ? <div className="text-xs text-[var(--app-hint)]">{t('settings.plugins.descriptor.noOptions')}</div> : null}
            {options.length > 0 ? (
                <div className="grid gap-2">
                    {options.map((option) => {
                        const label = descriptorText(option.label, locale) || option.value
                        const description = descriptorText(option.description, locale)
                            || (typeof option.count === 'number' ? t('settings.plugins.descriptor.optionCount', { count: option.count }) : '')
                        return (
                            <label key={option.value} className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={selectedSet.has(option.value)}
                                    disabled={disabled}
                                    onChange={(event) => toggleValue(option.value, event.target.checked)}
                                    className="mt-0.5 accent-[var(--app-link)]"
                                />
                                <span className="min-w-0">
                                    <span className="block break-words font-medium">{label}</span>
                                    {description ? <span className="block break-all text-xs text-[var(--app-hint)]">{description}</span> : null}
                                </span>
                            </label>
                        )
                    })}
                </div>
            ) : null}
            {props.field.allowCustom === false ? null : (
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                    <input
                        type="text"
                        value={customValue}
                        disabled={disabled}
                        placeholder={t('settings.plugins.descriptor.customPlaceholder')}
                        onChange={(event) => setCustomValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault()
                                addCustomValue()
                            }
                        }}
                        className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                    />
                    <Button type="button" size="sm" variant="outline" disabled={disabled || listFromValue(customValue).length === 0} onClick={addCustomValue}>
                        {t('settings.plugins.descriptor.addCustom')}
                    </Button>
                </div>
            )}
        </div>
    )
}

function SchemaFormComponent(props: {
    component: Extract<WebDescriptorComponent, { kind: 'schemaForm' }>
    config: Record<string, unknown>
    disabled?: boolean
    optionSources?: DescriptorOptionSources
    onSaveConfig?: DescriptorConfigSaveHandler
    onConfigChange?: DescriptorConfigChangeHandler
}) {
    const { component, config } = props
    const { t, locale } = useTranslation()
    const [values, setValues] = useState<Record<string, unknown>>({})
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        setValues(Object.fromEntries(component.fields.map((field) => [field.key, initialFieldValue(field, config)])))
        setError(null)
    }, [component, config])

    const requiredMissing = component.fields.find((field) => field.required && !field.secret && valueIsBlank(values[field.key]))

    const updateFieldValue = (field: WebSchemaFormField, value: unknown) => {
        const nextValues = { ...values, [field.key]: value }
        setValues(nextValues)
        if (props.onConfigChange && !field.secret) {
            props.onConfigChange(buildNextConfig(component.fields, config, nextValues))
        }
    }

    const save = async () => {
        if (!props.onSaveConfig || props.disabled) return
        if (requiredMissing) {
            setError(t('settings.plugins.descriptor.required', { label: descriptorText(requiredMissing.label, locale) }))
            return
        }
        const nextConfig = buildNextConfig(component.fields, config, values)
        setSaving(true)
        setError(null)
        try {
            await props.onSaveConfig(nextConfig)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="min-w-0 space-y-3 overflow-hidden rounded-lg border border-[var(--app-border)] p-3">
            {component.title ? <div className="min-w-0 break-words font-medium">{descriptorText(component.title, locale)}</div> : null}
            {component.description ? <div className="min-w-0 break-words text-sm text-[var(--app-hint)] [overflow-wrap:anywhere]">{descriptorText(component.description, locale)}</div> : null}
            <div className="min-w-0 space-y-3">
                {component.fields.map((field) => {
                    const value = values[field.key]
                    const label = descriptorText(field.label, locale)
                    const description = descriptorText(field.description, locale)
                    if (!field.secret && field.type === 'multiSelect') {
                        return (
                            <div key={field.key} className="block min-w-0 space-y-1 text-sm">
                                <span className="block min-w-0 break-words font-medium">{label}{field.required ? ' *' : ''}</span>
                                {description ? <span className="block min-w-0 break-words text-xs text-[var(--app-hint)] [overflow-wrap:anywhere]">{description}</span> : null}
                                <SchemaMultiSelectField
                                    field={field}
                                    value={value}
                                    options={optionsForField(field, props.optionSources)}
                                    sourceReady={!field.optionsSource || props.optionSources?.[field.optionsSource] !== undefined}
                                    disabled={props.disabled}
                                    saving={saving}
                                    onChange={(nextValue) => updateFieldValue(field, nextValue)}
                                />
                            </div>
                        )
                    }
                    if (!field.secret && field.type === 'boolean') {
                        return (
                            <label key={field.key} className="flex min-w-0 items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={value === true}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => updateFieldValue(field, event.target.checked)}
                                    className="mt-0.5 shrink-0 accent-[var(--app-link)]"
                                />
                                <span className="min-w-0">
                                    <span className="block min-w-0 break-words font-medium">{label}{field.required ? ' *' : ''}</span>
                                    {description ? <span className="block min-w-0 break-words text-xs text-[var(--app-hint)] [overflow-wrap:anywhere]">{description}</span> : null}
                                </span>
                            </label>
                        )
                    }
                    return (
                        <label key={field.key} className="block min-w-0 space-y-1 text-sm">
                            <span className="block min-w-0 break-words font-medium">{label}{field.required ? ' *' : ''}</span>
                            {description ? <span className="block min-w-0 break-words text-xs text-[var(--app-hint)] [overflow-wrap:anywhere]">{description}</span> : null}
                            {field.secret ? (
                                <input
                                    type="password"
                                    value=""
                                    disabled
                                    placeholder={t('settings.plugins.descriptor.secretPlaceholder')}
                                    className="w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-hint)]"
                                />
                            ) : field.type === 'select' ? (
                                <select
                                    value={typeof value === 'string' ? value : ''}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => updateFieldValue(field, event.target.value)}
                                    className="w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                                >
                                    <option value="">{t('settings.plugins.descriptor.select')}</option>
                                    {optionsForField(field, props.optionSources).map((option) => <option key={option.value} value={option.value}>{descriptorText(option.label, locale) || option.value}</option>)}
                                </select>
                            ) : fieldWantsMultilineText(field) ? (
                                <textarea
                                    value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => updateFieldValue(field, event.target.value)}
                                    spellCheck={false}
                                    rows={5}
                                    className="min-h-28 w-full min-w-0 resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                />
                            ) : (
                                <input
                                    type={field.type === 'number' ? 'number' : 'text'}
                                    value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                                    disabled={props.disabled || saving}
                                    onChange={(event) => updateFieldValue(field, event.target.value)}
                                    className="w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                                />
                            )}
                        </label>
                    )
                })}
            </div>
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
            {props.onSaveConfig ? (
                <Button type="button" size="sm" disabled={props.disabled || saving || Boolean(requiredMissing)} onClick={() => void save()}>
                    {saving ? t('settings.plugins.config.saving') : descriptorText(component.submitLabel, locale) || t('settings.plugins.config.saveAndReload')}
                </Button>
            ) : null}
        </div>
    )
}

function DescriptorComponent(props: {
    component: WebDescriptorComponent
    config: Record<string, unknown>
    disabled?: boolean
    optionSources?: DescriptorOptionSources
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
    onConfigChange?: DescriptorConfigChangeHandler
    machines?: Machine[]
    targetMachineId?: string | null
    dirty?: boolean
}) {
    const { t, locale } = useTranslation()
    const parsed = WebDescriptorComponentSchema.safeParse(props.component)
    if (!parsed.success) {
        return <DescriptorError message={t('settings.plugins.descriptor.invalidComponent')} />
    }
    const component = parsed.data
    if (component.kind === 'text') {
        const tone = component.tone === 'danger'
            ? 'text-red-600'
            : component.tone === 'warning'
                ? 'text-amber-600'
                : component.tone === 'muted'
                    ? 'text-[var(--app-hint)]'
                    : ''
        return <div className={`min-w-0 break-words text-sm [overflow-wrap:anywhere] ${tone}`}>{descriptorText(component.text, locale)}</div>
    }
    if (component.kind === 'badge') {
        return <Badge variant={badgeVariant(component.variant)}>{descriptorText(component.label, locale)}</Badge>
    }
    if (component.kind === 'table') {
        return (
            <div className="overflow-x-auto rounded-lg border border-[var(--app-border)]">
                <table className="min-w-full text-left text-sm">
                    <thead className="bg-[var(--app-subtle-bg)] text-xs text-[var(--app-hint)]">
                        <tr>{component.columns.map((column) => <th key={column.key} className="px-3 py-2 font-medium">{descriptorText(column.label, locale)}</th>)}</tr>
                    </thead>
                    <tbody>
                        {component.rows.map((row, index) => (
                            <tr key={index} className="border-t border-[var(--app-border)]">
                                {component.columns.map((column) => <td key={column.key} className="px-3 py-2">{String(row[column.key] ?? '')}</td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        )
    }
    if (component.kind === 'actionButton') {
        const action = CorePluginActionIdSchema.safeParse(component.actionId)
        if (!action.success) {
            return <DescriptorError message={t('settings.plugins.descriptor.unsupportedAction')} />
        }
        const run = async () => {
            if (!props.onAction) return
            if (component.confirm) {
                const ok = window.confirm(`${descriptorText(component.confirm.title, locale)}${component.confirm.description ? `\n\n${descriptorText(component.confirm.description, locale)}` : ''}`)
                if (!ok) return
            }
            await props.onAction(action.data)
        }
        return (
            <Button type="button" size="sm" variant={component.variant === 'danger' ? 'destructive' : component.variant === 'secondary' ? 'outline' : 'default'} disabled={props.disabled} onClick={() => void run()}>
                {descriptorText(component.label, locale)}
            </Button>
        )
    }
    if (component.kind === 'runnerSpawnDefaultsEditor') {
        return (
            <RunnerSpawnDefaultsEditor
                config={props.config}
                machines={props.machines ?? []}
                targetMachineId={props.targetMachineId}
                optionSources={props.optionSources}
                disabled={props.disabled}
                dirty={props.dirty}
                configKey={component.configKey}
                onConfigChange={(nextConfig) => props.onConfigChange?.(nextConfig)}
            />
        )
    }
    return <SchemaFormComponent component={component} config={props.config} disabled={props.disabled} optionSources={props.optionSources} onSaveConfig={props.onSaveConfig} onConfigChange={props.onConfigChange} />
}

function DescriptorError(props: { message: string }) {
    return <div className="rounded-lg border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] p-3 text-sm text-[var(--app-badge-error-text)]">{props.message}</div>
}


function readSettingsPanels(contributions: unknown): unknown[] {
    if (!contributions || typeof contributions !== 'object') return []
    const panels = (contributions as { settingsPanels?: unknown }).settingsPanels
    return Array.isArray(panels) ? panels : []
}


function parsePanelShell(panel: unknown): { success: true; id: string; title: WebLocalizedText; description?: WebLocalizedText; components: unknown[] } | { success: false } {
    if (!panel || typeof panel !== 'object') return { success: false }
    const obj = panel as Record<string, unknown>
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id : ''
    const title = WebLocalizedTextSchema.safeParse(obj.title)
    const description = obj.description === undefined ? undefined : WebLocalizedTextSchema.safeParse(obj.description)
    const components = Array.isArray(obj.components) ? obj.components : null
    if (!id || !title.success || !components || (description && !description.success)) return { success: false }
    return {
        success: true,
        id,
        title: title.data,
        ...(description?.success ? { description: description.data } : {}),
        components
    }
}

export function PluginDescriptorPanels(props: {
    contributions: unknown
    config?: Record<string, unknown>
    disabled?: boolean
    optionSources?: DescriptorOptionSources
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
    onConfigChange?: DescriptorConfigChangeHandler
    machines?: Machine[]
    targetMachineId?: string | null
    dirty?: boolean
}) {
    const panels = readSettingsPanels(props.contributions)
    if (panels.length === 0) return null
    return <PluginSettingsPanels panels={panels} config={props.config} disabled={props.disabled} optionSources={props.optionSources} onAction={props.onAction} onSaveConfig={props.onSaveConfig} onConfigChange={props.onConfigChange} machines={props.machines} targetMachineId={props.targetMachineId} dirty={props.dirty} />
}

export function PluginSettingsPanels(props: {
    panels: unknown[]
    config?: Record<string, unknown>
    disabled?: boolean
    optionSources?: DescriptorOptionSources
    onAction?: DescriptorActionHandler
    onSaveConfig?: DescriptorConfigSaveHandler
    onConfigChange?: DescriptorConfigChangeHandler
    machines?: Machine[]
    targetMachineId?: string | null
    dirty?: boolean
}) {
    const { t, locale } = useTranslation()
    const parsed = useMemo(() => props.panels.map((panel) => parsePanelShell(panel)), [props.panels])

    return (
        <div className="min-w-0 space-y-3">
            {parsed.map((entry, index) => {
                if (!entry.success) {
                    return <DescriptorError key={`invalid-${index}`} message={t('settings.plugins.descriptor.invalidPanel')} />
                }
                const panel = entry
                return (
                    <DescriptorBoundary key={panel.id} fallback={<DescriptorError message={t('settings.plugins.descriptor.panelRenderFailed')} />}>
                        <div className="min-w-0 space-y-3 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                            <div className="min-w-0">
                                <div className="min-w-0 break-words font-medium">{descriptorText(panel.title, locale)}</div>
                                {panel.description ? <div className="mt-1 min-w-0 break-words text-sm text-[var(--app-hint)] [overflow-wrap:anywhere]">{descriptorText(panel.description, locale)}</div> : null}
                            </div>
                            <div className="min-w-0 space-y-3">
                                {panel.components.map((component, componentIndex) => {
                                    const parsedComponent = WebDescriptorComponentSchema.safeParse(component)
                                    if (!parsedComponent.success) {
                                        return <DescriptorError key={`invalid-component-${componentIndex}`} message={t('settings.plugins.descriptor.componentValidationFailed')} />
                                    }
                                    return (
                                        <DescriptorComponent
                                            key={componentKey(parsedComponent.data, componentIndex)}
                                            component={parsedComponent.data}
                                            config={props.config ?? {}}
                                            disabled={props.disabled}
                                            optionSources={props.optionSources}
                                            onAction={props.onAction}
                                            onSaveConfig={props.onSaveConfig}
                                            onConfigChange={props.onConfigChange}
                                            machines={props.machines}
                                            targetMachineId={props.targetMachineId}
                                            dirty={props.dirty}
                                        />
                                    )
                                })}
                            </div>
                        </div>
                    </DescriptorBoundary>
                )
            })}
        </div>
    )
}
