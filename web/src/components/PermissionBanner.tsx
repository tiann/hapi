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

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function parseErrorMessage(e: unknown): string {
    const message = e instanceof Error ? e.message : 'Request failed'
    // Check for "Session is inactive" error (HTTP 409)
    if (message.includes('Session is inactive') || message.includes('409')) {
        return 'Session became inactive. Wait for it to reconnect and try again.'
    }
    // Check for "Request not found" error (HTTP 404)
    if (message.includes('Request not found') || message.includes('not found')) {
        return 'Permission request no longer exists. It may have been handled already.'
    }
    return message
}

export function PermissionBanner(props: {
    api: ApiClient
    sessionId: string
    requestId: string
    request: AgentStateRequest
    onDone: () => void
    disabled?: boolean
}) {
    const [isWorking, setIsWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const editArgs = useMemo(() => getEditArgs(props.request.arguments), [props.request.arguments])

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

    return (
        <div className="border-b border-[var(--app-border)] bg-amber-500/10 p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                        ⚠️ {props.request.tool}
                        {editArgs.filePath ? `: ${editArgs.filePath}` : ''}
                    </div>
                    <div className="text-xs text-[var(--app-hint)] truncate">
                        {props.requestId}
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                        size="sm"
                        disabled={isWorking || props.disabled}
                        onClick={() => run(() => props.api.approvePermission(props.sessionId, props.requestId, 'default'), 'success')}
                    >
                        Allow
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
                    <Button
                        variant="destructive"
                        size="sm"
                        disabled={isWorking || props.disabled}
                        onClick={() => run(() => props.api.denyPermission(props.sessionId, props.requestId), 'success')}
                    >
                        Deny
                    </Button>
                </div>
            </div>

            <div className="mt-3">
                {props.request.tool === 'Edit' && editArgs.oldString !== null && editArgs.newString !== null ? (
                    <DiffView
                        oldString={editArgs.oldString}
                        newString={editArgs.newString}
                        filePath={editArgs.filePath ?? undefined}
                    />
                ) : (
                    <CodeBlock
                        code={safeStringify(props.request.arguments)}
                        language="json"
                    />
                )}
            </div>

            {error ? (
                <div className="mt-2 text-sm text-red-600">
                    {error}
                </div>
            ) : null}
        </div>
    )
}
