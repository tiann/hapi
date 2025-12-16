import { useMemo, useState } from 'react'
import type { AgentStateRequest } from '@/types/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

function formatArgs(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') {
        return ''
    }
    const obj = args as any

    if (tool === 'Edit') {
        const filePath = obj.file_path ?? obj.path
        const oldString = obj.old_string
        const newString = obj.new_string
        return [
            filePath ? `file: ${filePath}` : null,
            oldString ? `old_string:\n${oldString}` : null,
            newString ? `new_string:\n${newString}` : null
        ].filter(Boolean).join('\n\n')
    }

    if (tool === 'Write') {
        const filePath = obj.file_path ?? obj.path
        const content = obj.content
        return [
            filePath ? `file: ${filePath}` : null,
            typeof content === 'string' ? `content:\n${content}` : null
        ].filter(Boolean).join('\n\n')
    }

    return JSON.stringify(args, null, 2)
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

export function PermissionDialog(props: {
    sessionId: string
    requestId: string
    request: AgentStateRequest
    onApprove: (mode?: 'default' | 'acceptEdits' | 'bypassPermissions') => Promise<void>
    onDeny: () => Promise<void>
    actionsDisabled?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [isWorking, setIsWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const formattedArgs = useMemo(() => formatArgs(props.request.tool, props.request.arguments), [props.request])

    async function run(action: () => Promise<void>) {
        setIsWorking(true)
        setError(null)
        try {
            await action()
            setOpen(false)
        } catch (e) {
            setError(parseErrorMessage(e))
        } finally {
            setIsWorking(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="secondary" size="sm">
                    View
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Permission Request</DialogTitle>
                    <DialogDescription>
                        {props.request.tool} ({props.requestId.slice(0, 8)})
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-3 flex flex-col gap-3">
                    <pre className="max-h-64 overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2 text-xs whitespace-pre-wrap">
                        {formattedArgs || '(no arguments)'}
                    </pre>

                    {error ? <div className="text-sm text-red-600">{error}</div> : null}

                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="default"
                            size="sm"
                            disabled={isWorking || props.actionsDisabled}
                            onClick={() => run(() => props.onApprove('default'))}
                        >
                            Allow
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={isWorking || props.actionsDisabled}
                            onClick={() => run(() => props.onApprove('acceptEdits'))}
                        >
                            Allow + Edits
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={isWorking || props.actionsDisabled}
                            onClick={() => run(() => props.onApprove('bypassPermissions'))}
                        >
                            Bypass
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            disabled={isWorking || props.actionsDisabled}
                            onClick={() => run(() => props.onDeny())}
                        >
                            Deny
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
