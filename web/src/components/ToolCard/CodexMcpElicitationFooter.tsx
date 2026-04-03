import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { Spinner } from '@/components/Spinner'
import {
    buildCodexMcpElicitationFormContent,
    createCodexMcpElicitationFormState,
    isCodexMcpElicitationToolName,
    normalizeCodexMcpElicitationFormSchema,
    parseCodexMcpElicitationInput,
    type CodexMcpElicitationFormField
} from '@/components/ToolCard/codexMcpElicitation'
import { usePlatform } from '@/hooks/usePlatform'

function ActionButton(props: {
    label: string
    tone: 'allow' | 'deny' | 'neutral'
    loading?: boolean
    disabled: boolean
    onClick: () => void
}) {
    const base = 'flex w-full items-center justify-between rounded-md px-2 py-2 text-sm text-left transition-colors disabled:pointer-events-none disabled:opacity-50 hover:bg-[var(--app-subtle-bg)]'
    const tone = props.tone === 'allow'
        ? 'text-emerald-600'
        : props.tone === 'deny'
            ? 'text-red-600'
            : 'text-[var(--app-link)]'

    return (
        <button
            type="button"
            className={`${base} ${tone}`}
            disabled={props.disabled}
            aria-busy={props.loading === true}
            onClick={props.onClick}
        >
            <span className="flex-1">{props.label}</span>
            {props.loading ? (
                <span className="ml-2 shrink-0">
                    <Spinner size="sm" label={null} className="text-current" />
                </span>
            ) : null}
        </button>
    )
}

export function CodexMcpElicitationFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { haptic } = usePlatform()
    const parsed = useMemo(() => parseCodexMcpElicitationInput(props.tool.input), [props.tool.input])
    const formSchema = useMemo(() => {
        if (!parsed || parsed.mode !== 'form') {
            return null
        }
        return normalizeCodexMcpElicitationFormSchema(parsed.requestedSchema)
    }, [parsed])
    const [loading, setLoading] = useState<'accept' | 'decline' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [formState, setFormState] = useState<Record<string, string | boolean | null>>({})

    useEffect(() => {
        setLoading(null)
        setError(null)
        setFormState(formSchema ? createCodexMcpElicitationFormState(formSchema) : {})
    }, [props.tool.id])

    if (!isCodexMcpElicitationToolName(props.tool.name)) return null
    if (!parsed) return null
    if (props.tool.state !== 'running' && props.tool.state !== 'pending') return null

    const run = async (action: () => Promise<void>) => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification('success')
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Request failed')
        }
    }

    const updateField = (key: string, value: string | boolean | null) => {
        setError(null)
        setFormState((prev) => ({
            ...prev,
            [key]: value
        }))
    }

    const submitAccept = async () => {
        if (loading) return

        let content: unknown | null = null
        if (parsed.mode === 'form') {
            if (!formSchema) {
                haptic.notification('error')
                setError('This MCP request requires a form schema before it can be submitted')
                return
            }

            const submission = buildCodexMcpElicitationFormContent(formSchema, formState)
            if (!submission.ok) {
                haptic.notification('error')
                setError(submission.error)
                return
            }

            content = submission.content
        }
        if (parsed.mode === 'url') {
            window.open(parsed.url, '_blank', 'noopener,noreferrer')
        }

        setLoading('accept')
        try {
            await run(() => props.api.respondToMcpElicitation(props.sessionId, parsed.requestId, {
                action: 'accept',
                content
            }))
        } finally {
            setLoading(null)
        }
    }

    const submitDecline = async () => {
        if (loading) return
        setLoading('decline')
        try {
            await run(() => props.api.respondToMcpElicitation(props.sessionId, parsed.requestId, {
                action: 'decline',
                content: null
            }))
        } finally {
            setLoading(null)
        }
    }

    const renderField = (field: CodexMcpElicitationFormField) => {
        const fieldId = `codex-mcp-elicitation-${parsed.requestId}-${field.key}`
        const commonClassName = 'w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] disabled:opacity-50'
        const draftValue = formState[field.key]

        return (
            <div key={field.key} className="flex flex-col gap-1">
                <label htmlFor={fieldId} className="text-xs font-medium text-[var(--app-hint)]">
                    {field.label}
                    {field.required ? ' *' : ''}
                </label>
                {field.description ? (
                    <div className="text-xs text-[var(--app-hint)]">
                        {field.description}
                    </div>
                ) : null}

                {field.kind === 'boolean' ? (
                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                        <input
                            id={fieldId}
                            type="checkbox"
                            className="h-4 w-4 rounded border-[var(--app-border)]"
                            checked={draftValue === true}
                            disabled={props.disabled || loading !== null}
                            onChange={(e) => updateField(field.key, e.target.checked)}
                        />
                    </div>
                ) : field.kind === 'enum' ? (
                    <select
                        id={fieldId}
                        value={typeof draftValue === 'string' ? draftValue : ''}
                        disabled={props.disabled || loading !== null}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className={commonClassName}
                    >
                        <option value="">Select an option</option>
                        {field.options.map((option, index) => (
                            <option key={`${field.key}-${index}`} value={`${index}`}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                ) : field.kind === 'json' ? (
                    <textarea
                        id={fieldId}
                        value={typeof draftValue === 'string' ? draftValue : ''}
                        disabled={props.disabled || loading !== null}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        placeholder='{"key":"value"}'
                        className={`${commonClassName} min-h-[88px] resize-y font-mono`}
                    />
                ) : (
                    <input
                        id={fieldId}
                        type={field.kind === 'string' ? 'text' : 'number'}
                        step={field.kind === 'integer' ? '1' : 'any'}
                        value={typeof draftValue === 'string' ? draftValue : ''}
                        disabled={props.disabled || loading !== null}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className={commonClassName}
                    />
                )}
            </div>
        )
    }

    const showsUnsupportedFormNotice = parsed.mode === 'form' && formSchema?.kind === 'unsupported'
    const unsupportedFormReason = formSchema?.kind === 'unsupported' ? formSchema.reason : null
    const formFields = parsed.mode === 'form' && formSchema?.kind === 'object'
        ? formSchema.fields
        : []
    const acceptDisabled = props.disabled
        || loading !== null
        || showsUnsupportedFormNotice

    return (
        <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            {showsUnsupportedFormNotice ? (
                <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                    {unsupportedFormReason}
                </div>
            ) : null}

            {formFields.length > 0 ? (
                <div className="mb-3 flex flex-col gap-3">
                    {formFields.map((field) => renderField(field))}
                </div>
            ) : null}

            {error ? (
                <div className="mb-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col gap-1">
                <ActionButton
                    label={parsed.mode === 'url' ? 'Open and continue' : 'Submit'}
                    tone="allow"
                    loading={loading === 'accept'}
                    disabled={acceptDisabled}
                    onClick={submitAccept}
                />
                <ActionButton
                    label="Decline"
                    tone="neutral"
                    loading={loading === 'decline'}
                    disabled={props.disabled || loading !== null}
                    onClick={submitDecline}
                />
            </div>
        </div>
    )
}
