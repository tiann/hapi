import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ChatToolCall, ToolPermission } from '@/chat/types'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getInputStringAny(input: unknown, keys: string[]): string | null {
    if (!isObject(input)) return null
    for (const key of keys) {
        const value = input[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function isToolAllowedForSession(toolName: string, toolInput: unknown, allowedTools: string[] | undefined): boolean {
    if (!allowedTools || allowedTools.length === 0) return false
    if (allowedTools.includes(toolName)) return true

    if (toolName === 'Bash') {
        const command = getInputStringAny(toolInput, ['command', 'cmd'])
        if (command) {
            return allowedTools.includes(`Bash(${command})`)
        }
    }

    return false
}

function isCodexSession(metadata: SessionMetadataSummary | null, toolName: string): boolean {
    return metadata?.flavor === 'codex'
        || metadata?.flavor === 'gemini'
        || toolName.startsWith('Codex')
        || toolName.startsWith('Gemini')
}

function formatPermissionSummary(permission: ToolPermission, toolName: string, toolInput: unknown, codex: boolean, t: (key: string) => string): string {
    if (permission.status === 'pending') return t('tool.waitingForApproval')
    if (permission.status === 'canceled') return permission.reason ? `${t('tool.canceled')}: ${permission.reason}` : t('tool.canceled')

    if (codex) {
        if (permission.status === 'approved' && permission.decision === 'approved_for_session') return t('tool.approvedForSession')
        if (permission.status === 'approved') return t('tool.approved')
        if (permission.status === 'denied' && permission.decision === 'abort') return permission.reason ? `${t('tool.aborted')}: ${permission.reason}` : t('tool.aborted')
        if (permission.status === 'denied') return permission.reason ? `${t('tool.deny')}: ${permission.reason}` : t('tool.deny')
        return t('tool.allow')
    }

    if (permission.status === 'approved') {
        if (permission.mode === 'acceptEdits') return t('tool.approvedAllowAllEdits')
        if (isToolAllowedForSession(toolName, toolInput, permission.allowedTools)) return t('tool.approvedForSession')
        return t('tool.approved')
    }

    if (permission.status === 'denied') {
        return permission.reason ? `${t('tool.deny')}: ${permission.reason}` : t('tool.deny')
    }

    return t('tool.allow')
}

function PermissionRowButton(props: {
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

export function PermissionFooter(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const [loading, setLoading] = useState<'allow' | 'deny' | 'abort' | null>(null)
    const [loadingAllEdits, setLoadingAllEdits] = useState(false)
    const [loadingForSession, setLoadingForSession] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const codex = useMemo(() => isCodexSession(props.metadata, props.tool.name), [props.metadata, props.tool.name])

    if (!permission) return null

    const summary = formatPermissionSummary(permission, props.tool.name, props.tool.input, codex, t)
    const isPending = permission.status === 'pending'

    const run = async (action: () => Promise<void>, hapticType: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(hapticType)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('tool.requestFailed'))
        }
    }

    const toolName = props.tool.name
    const isEditTool = toolName === 'Edit'
        || toolName === 'MultiEdit'
        || toolName === 'Write'
        || toolName === 'NotebookEdit'
    const hideAllowForSession = toolName === 'Edit'
        || toolName === 'MultiEdit'
        || toolName === 'Write'
        || toolName === 'NotebookEdit'
        || toolName === 'exit_plan_mode'
        || toolName === 'ExitPlanMode'

    const canAllowForSession = !codex && isPending && !hideAllowForSession
    const canAllowAllEdits = !codex && isPending && isEditTool

    const approve = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoading('allow')
        await run(() => props.api.approvePermission(props.sessionId, permission.id), 'success')
        setLoading(null)
    }

    const approveAllEdits = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoadingAllEdits(true)
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'acceptEdits'), 'success')
        setLoadingAllEdits(false)
    }

    const approveForSession = async () => {
        if (!canAllowForSession || loading || loadingAllEdits || loadingForSession) return
        setLoadingForSession(true)
        const command = toolName === 'Bash' ? getInputStringAny(props.tool.input, ['command', 'cmd']) : null
        const toolIdentifier = toolName === 'Bash' && command ? `Bash(${command})` : toolName
        await run(() => props.api.approvePermission(props.sessionId, permission.id, { allowTools: [toolIdentifier] }), 'success')
        setLoadingForSession(false)
    }

    const deny = async () => {
        if (!isPending || loading || loadingAllEdits || loadingForSession) return
        setLoading('deny')
        await run(() => props.api.denyPermission(props.sessionId, permission.id), 'success')
        setLoading(null)
    }

    const codexApprove = async (decision: 'approved' | 'approved_for_session') => {
        if (!isPending || loading || loadingForSession) return
        if (decision === 'approved_for_session') {
            setLoadingForSession(true)
            await run(() => props.api.approvePermission(props.sessionId, permission.id, { decision }), 'success')
            setLoadingForSession(false)
            return
        }
        setLoading('allow')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, { decision }), 'success')
        setLoading(null)
    }

    const codexAbort = async () => {
        if (!isPending || loading || loadingForSession) return
        setLoading('abort')
        await run(() => props.api.denyPermission(props.sessionId, permission.id, { decision: 'abort' }), 'success')
        setLoading(null)
    }

    if (!isPending) {
        // Keep the thread minimal: approval is already reflected by tool state/icon.
        // Only surface a short message when the permission was denied/canceled and we have a reason.
        if (permission.status !== 'denied' && permission.status !== 'canceled') return null
        if (!permission.reason) return null

        return (
            <div className="mt-2 text-xs text-red-600">
                {permission.reason}
            </div>
        )
    }

    return (
        <div className="mt-2">
            <div className="text-xs text-[var(--app-hint)]">{summary}</div>

            {error ? (
                <div className="mt-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="mt-2 flex flex-col gap-1">
                {codex ? (
                    <>
                        <PermissionRowButton
                            label={t('tool.yes')}
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={() => codexApprove('approved')}
                        />
                        <PermissionRowButton
                            label={t('tool.yesForSession')}
                            tone="neutral"
                            loading={loadingForSession}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={() => codexApprove('approved_for_session')}
                        />
                        <PermissionRowButton
                            label={t('tool.abortLabel')}
                            tone="deny"
                            loading={loading === 'abort'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={codexAbort}
                        />
                    </>
                ) : (
                    <>
                        <PermissionRowButton
                            label={t('tool.allow')}
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                            onClick={approve}
                        />
                        {canAllowForSession ? (
                            <PermissionRowButton
                                label={t('tool.allowForSession')}
                                tone="neutral"
                                loading={loadingForSession}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveForSession}
                            />
                        ) : null}
                        {canAllowAllEdits ? (
                            <PermissionRowButton
                                label={t('tool.allowAll')}
                                tone="neutral"
                                loading={loadingAllEdits}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveAllEdits}
                            />
                        ) : null}
                        <PermissionRowButton
                            label={t('tool.deny')}
                            tone="deny"
                            loading={loading === 'deny'}
                            disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                            onClick={deny}
                        />
                    </>
                )}
            </div>
        </div>
    )
}
