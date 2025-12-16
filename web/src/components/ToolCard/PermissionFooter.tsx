import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ChatToolCall, ToolPermission } from '@/chat/types'
import { getTelegramWebApp } from '@/hooks/useTelegram'

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
    return metadata?.flavor === 'codex' || toolName.startsWith('Codex')
}

function formatPermissionSummary(permission: ToolPermission, toolName: string, toolInput: unknown, codex: boolean): string {
    if (permission.status === 'pending') return 'Waiting for approval…'
    if (permission.status === 'canceled') return permission.reason ? `Canceled: ${permission.reason}` : 'Canceled'

    if (codex) {
        if (permission.status === 'approved' && permission.decision === 'approved_for_session') return 'Approved for session'
        if (permission.status === 'approved') return 'Approved'
        if (permission.status === 'denied' && permission.decision === 'abort') return permission.reason ? `Aborted: ${permission.reason}` : 'Aborted'
        if (permission.status === 'denied') return permission.reason ? `Denied: ${permission.reason}` : 'Denied'
        return 'Permission'
    }

    if (permission.status === 'approved') {
        if (permission.mode === 'acceptEdits') return 'Approved: Allow all edits'
        if (isToolAllowedForSession(toolName, toolInput, permission.allowedTools)) return 'Approved: Allow for session'
        return 'Approved'
    }

    if (permission.status === 'denied') {
        return permission.reason ? `Denied: ${permission.reason}` : 'Denied'
    }

    return 'Permission'
}

function SpinnerIcon(props: { className?: string }) {
    return (
        <svg className={props.className ?? 'h-4 w-4 animate-spin'} viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
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
            onClick={props.onClick}
        >
            <span className="flex-1">{props.label}</span>
            {props.loading ? (
                <span className="ml-2 shrink-0">
                    <SpinnerIcon />
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
    const permission = props.tool.permission
    const [loading, setLoading] = useState<'allow' | 'deny' | 'abort' | null>(null)
    const [loadingAllEdits, setLoadingAllEdits] = useState(false)
    const [loadingForSession, setLoadingForSession] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const codex = useMemo(() => isCodexSession(props.metadata, props.tool.name), [props.metadata, props.tool.name])

    if (!permission) return null

    const summary = formatPermissionSummary(permission, props.tool.name, props.tool.input, codex)
    const isPending = permission.status === 'pending'

    const run = async (action: () => Promise<void>, haptic: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred(haptic)
            props.onDone()
        } catch (e) {
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
            setError(e instanceof Error ? e.message : 'Request failed')
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
        const tone = permission.status === 'approved'
            ? 'text-emerald-600'
            : permission.status === 'denied' || permission.status === 'canceled'
                ? 'text-red-600'
                : 'text-[var(--app-hint)]'

        return (
            <div className={`mt-2 text-xs ${tone}`}>
                {summary}
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
                            label="Yes"
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={() => codexApprove('approved')}
                        />
                        <PermissionRowButton
                            label="Yes for session"
                            tone="neutral"
                            loading={loadingForSession}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={() => codexApprove('approved_for_session')}
                        />
                        <PermissionRowButton
                            label="Abort"
                            tone="deny"
                            loading={loading === 'abort'}
                            disabled={props.disabled || loading !== null || loadingForSession}
                            onClick={codexAbort}
                        />
                    </>
                ) : (
                    <>
                        <PermissionRowButton
                            label="Allow"
                            tone="allow"
                            loading={loading === 'allow'}
                            disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                            onClick={approve}
                        />
                        {canAllowForSession ? (
                            <PermissionRowButton
                                label="Allow for session"
                                tone="neutral"
                                loading={loadingForSession}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveForSession}
                            />
                        ) : null}
                        {canAllowAllEdits ? (
                            <PermissionRowButton
                                label="Allow all edits"
                                tone="neutral"
                                loading={loadingAllEdits}
                                disabled={props.disabled || loading !== null || loadingAllEdits || loadingForSession}
                                onClick={approveAllEdits}
                            />
                        ) : null}
                        <PermissionRowButton
                            label="Deny"
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
