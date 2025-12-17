import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ModelMode, PermissionMode, Session } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { getTelegramWebApp } from '@/hooks/useTelegram'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function toPermissionMode(mode: PermissionMode): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
    if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan') return mode
    return 'default'
}

function toModelMode(mode: ModelMode): 'default' | 'sonnet' | 'opus' {
    if (mode === 'sonnet' || mode === 'opus') return mode
    return 'default'
}

export function SessionHeader(props: {
    api: ApiClient
    session: Session
    onBack: () => void
    onRefresh: () => void
}) {
    const title = useMemo(() => getSessionTitle(props.session), [props.session])
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [isWorking, setIsWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const permissionMode = toPermissionMode(props.session.permissionMode)
    const modelMode = toModelMode(props.session.modelMode)
    const controlsDisabled = isWorking || !props.session.active

    async function run(action: () => Promise<void>) {
        setIsWorking(true)
        setError(null)
        try {
            await action()
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('success')
            props.onRefresh()
            setSettingsOpen(false)
        } catch (e) {
            getTelegramWebApp()?.HapticFeedback?.notificationOccurred('error')
            setError(e instanceof Error ? e.message : 'Request failed')
        } finally {
            setIsWorking(false)
        }
    }

    return (
        <div className="flex items-center gap-2 bg-[var(--app-bg)] p-3">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className={props.session.active ? 'h-2.5 w-2.5 rounded-full bg-emerald-500' : 'h-2.5 w-2.5 rounded-full bg-gray-400'}
                        title={props.session.active ? 'active' : 'offline'}
                        aria-label={props.session.active ? 'active' : 'offline'}
                    />
                    <div className="truncate font-semibold">
                        {title}
                    </div>
                    {props.session.thinking ? (
                        <span
                            className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse"
                            title="thinking"
                            aria-label="thinking"
                        />
                    ) : null}
                </div>
                <div className="text-xs text-[var(--app-hint)] truncate">
                    {props.session.metadata?.host ? `Host: ${props.session.metadata.host}` : props.session.id}
                </div>
            </div>

            <div className="flex items-center gap-2">
                <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
                    <DialogTrigger asChild>
                        <Button variant="secondary" size="sm">
                            ⚙️
                        </Button>
                    </DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Session Settings</DialogTitle>
                            <DialogDescription className="truncate">
                                {props.session.metadata?.path ?? props.session.id}
                            </DialogDescription>
                        </DialogHeader>

                        <div className="mt-3 flex flex-col gap-4">
                            <div>
                                <div className="mb-2 text-sm font-medium">Permission Mode</div>
                                <div className="flex flex-wrap gap-2">
                                    {(['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const).map((mode) => (
                                        <Button
                                            key={mode}
                                            size="sm"
                                            variant={permissionMode === mode ? 'default' : 'secondary'}
                                            disabled={controlsDisabled}
                                            onClick={() => run(() => props.api.setPermissionMode(props.session.id, mode))}
                                        >
                                            {mode}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <div className="mb-2 text-sm font-medium">Model</div>
                                <div className="flex flex-wrap gap-2">
                                    {(['default', 'sonnet', 'opus'] as const).map((model) => (
                                        <Button
                                            key={model}
                                            size="sm"
                                            variant={modelMode === model ? 'default' : 'secondary'}
                                            disabled={controlsDisabled}
                                            onClick={() => run(() => props.api.setModelMode(props.session.id, model))}
                                        >
                                            {model}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="rounded-md bg-[var(--app-subtle-bg)] p-2 text-xs text-[var(--app-hint)]">
                                <div>Path: {props.session.metadata?.path ?? '(unknown)'}</div>
                                <div>Host: {props.session.metadata?.host ?? '(unknown)'}</div>
                                <div>Status: {props.session.active ? 'Active' : 'Inactive'}</div>
                            </div>

                            {error ? (
                                <div className="text-sm text-red-600">
                                    {error}
                                </div>
                            ) : null}

                            <Button
                                variant="destructive"
                                disabled={controlsDisabled}
                                onClick={() => run(() => props.api.abortSession(props.session.id))}
                            >
                                🛑 Abort Session
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        </div>
    )
}
