import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AgentStateRequest } from '@/types/api'
import { Button } from '@/components/ui/button'
import { DiffView } from '@/components/DiffView'
import { CodeBlock } from '@/components/CodeBlock'
import { getTelegramWebApp } from '@/hooks/useTelegram'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getEditArgs(args: unknown): { filePath: string | null; oldString: string | null; newString: string | null } {
    if (!isObject(args)) {
        return { filePath: null, oldString: null, newString: null }
    }
    const filePath = typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string'
            ? args.path
            : null

    const oldString = typeof args.old_string === 'string' ? args.old_string : null
    const newString = typeof args.new_string === 'string' ? args.new_string : null

    return { filePath, oldString, newString }
}

function getFilePath(args: unknown): string | null {
    if (!isObject(args)) return null
    if (typeof args.file_path === 'string') return args.file_path
    if (typeof args.path === 'string') return args.path
    return null
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function parseErrorMessage(e: unknown): string {
    const message = e instanceof Error ? e.message : 'Request failed'
    if (message.includes('Session is inactive') || message.includes('409')) {
        return 'Session became inactive. Wait for it to reconnect.'
    }
    if (message.includes('Request not found') || message.includes('not found')) {
        return 'Request no longer exists.'
    }
    return message
}

export function PermissionPanel(props: {
    api: ApiClient
    sessionId: string
    requestId: string
    request: AgentStateRequest
    disabled: boolean
    onDone: () => void
}) {
    const [isWorking, setIsWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const editArgs = useMemo(() => getEditArgs(props.request.arguments), [props.request.arguments])
    const filePath = useMemo(() => getFilePath(props.request.arguments), [props.request.arguments])

    async function run(action: () => Promise<void>, haptic: 'success' | 'error') {
        setIsWorking(true)
        setError(null)
        try {
            await action()
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred(haptic)
            props.onDone()
        } catch (e) {
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
            setError(parseErrorMessage(e))
        } finally {
            setIsWorking(false)
        }
    }

    const isEdit = props.request.tool === 'Edit' && editArgs.oldString !== null && editArgs.newString !== null

    return (
        <div className="border-t border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            {/* Header */}
            <div className="mb-2">
                <div className="text-sm font-semibold">
                    ⚠️ {props.request.tool}
                </div>
                {filePath ? (
                    <div className="text-xs text-[var(--app-hint)] truncate">
                        {filePath}
                    </div>
                ) : null}
            </div>

            {/* Content preview */}
            <div className="mb-3 max-h-40 overflow-auto rounded border border-[var(--app-border)]">
                {isEdit ? (
                    <DiffView
                        oldString={editArgs.oldString!}
                        newString={editArgs.newString!}
                    />
                ) : (
                    <CodeBlock
                        code={safeStringify(props.request.arguments)}
                        language="json"
                    />
                )}
            </div>

            {/* Error */}
            {error ? (
                <div className="mb-2 text-sm text-red-600">
                    {error}
                </div>
            ) : null}

            {/* 2x2 Button grid */}
            <div className="grid grid-cols-2 gap-2">
                <Button
                    size="sm"
                    disabled={isWorking || props.disabled}
                    onClick={() => run(() => props.api.approvePermission(props.sessionId, props.requestId, 'default'), 'success')}
                >
                    Allow
                </Button>
                <Button
                    variant="destructive"
                    size="sm"
                    disabled={isWorking || props.disabled}
                    onClick={() => run(() => props.api.denyPermission(props.sessionId, props.requestId), 'success')}
                >
                    Deny
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={isWorking || props.disabled}
                    onClick={() => run(() => props.api.approvePermission(props.sessionId, props.requestId, 'acceptEdits'), 'success')}
                >
                    Allow+Edits
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={isWorking || props.disabled}
                    onClick={() => run(() => props.api.approvePermission(props.sessionId, props.requestId, 'bypassPermissions'), 'success')}
                >
                    Bypass
                </Button>
            </div>
        </div>
    )
}
