import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import type { ExitPlanImplementationMode } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { usePlatform } from '@/hooks/usePlatform'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import {
    getExitPlanImplementationModeDescription,
    getExitPlanImplementationModeLabel,
    getExitPlanImplementationModes,
    getExitPlanPermissionModes,
    getExitPlanPermissionModeLabel,
    getExitPlanPermissionModeDescription,
    isExitPlanModeToolName
} from '@/components/ToolCard/exitPlanMode'

type ExitPlanPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

function SelectionMark(props: { checked: boolean }) {
    return (
        <span className="mt-0.5 w-4 shrink-0 text-center text-[var(--app-hint)]">
            {props.checked ? '●' : '○'}
        </span>
    )
}

function OptionRow(props: {
    checked: boolean
    disabled: boolean
    title: string
    description: string
    onClick: () => void
}) {
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg)] disabled:pointer-events-none disabled:opacity-50',
                props.checked ? 'bg-[var(--app-subtle-bg)]' : null
            )}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <SelectionMark checked={props.checked} />
            <span className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--app-fg)]">
                    {props.title}
                </div>
                <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                    {props.description}
                </div>
            </span>
        </button>
    )
}

export function ExitPlanModeFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const [selectedMode, setSelectedMode] = useState<ExitPlanImplementationMode | null>(null)
    const [selectedPermissionMode, setSelectedPermissionMode] = useState<ExitPlanPermissionMode>('default')
    const [loading, setLoading] = useState<'approve' | 'deny' | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        setSelectedMode(null)
        setSelectedPermissionMode('default')
        setLoading(null)
        setError(null)
    }, [props.tool.id])

    if (!permission || permission.status !== 'pending') return null
    if (!isExitPlanModeToolName(props.tool.name)) return null

    const run = async (action: () => Promise<void>, hapticType: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(hapticType)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('dialog.error.default'))
        }
    }

    const approve = async () => {
        if (loading || props.disabled) return
        if (!selectedMode) {
            setError(t('tool.exitPlanMode.selectOption'))
            return
        }

        setLoading('approve')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, {
            mode: selectedPermissionMode,
            implementationMode: selectedMode
        }), 'success')
        setLoading(null)
    }

    const deny = async () => {
        if (loading || props.disabled) return
        setLoading('deny')
        await run(() => props.api.denyPermission(props.sessionId, permission.id), 'error')
        setLoading(null)
    }

    return (
        <div className="mt-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Badge variant="default">
                            {t('tool.exitPlanMode.badge')}
                        </Badge>
                    </div>
                    <div className="mt-2 text-sm text-[var(--app-fg)]">
                        {t('tool.exitPlanMode.prompt')}
                    </div>
                </div>
            </div>

            {error ? (
                <div className="mt-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="mt-3 flex flex-col gap-1">
                {getExitPlanImplementationModes().map((mode) => (
                    <OptionRow
                        key={mode}
                        checked={selectedMode === mode}
                        disabled={props.disabled || loading !== null}
                        title={getExitPlanImplementationModeLabel(mode, t)}
                        description={getExitPlanImplementationModeDescription(mode, t)}
                        onClick={() => {
                            haptic.selection()
                            setSelectedMode(mode)
                            setError(null)
                        }}
                    />
                ))}
            </div>

            <div className="mt-2 text-sm text-[var(--app-fg)]">
                {t('tool.exitPlanMode.permissionMode.prompt')}
            </div>

            <div className="mt-2 flex flex-col gap-1">
                {getExitPlanPermissionModes().map((mode) => (
                    <OptionRow
                        key={mode}
                        checked={selectedPermissionMode === mode}
                        disabled={props.disabled || loading !== null}
                        title={getExitPlanPermissionModeLabel(mode, t)}
                        description={getExitPlanPermissionModeDescription(mode, t)}
                        onClick={() => {
                            haptic.selection()
                            setSelectedPermissionMode(mode)
                            setError(null)
                        }}
                    />
                ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={props.disabled || loading !== null}
                    onClick={deny}
                >
                    {loading === 'deny' ? (
                        <>
                            <Spinner size="sm" label={null} className="mr-2" />
                            {t('tool.deny')}
                        </>
                    ) : (
                        t('tool.deny')
                    )}
                </Button>

                <Button
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={props.disabled || loading !== null}
                    onClick={approve}
                    aria-busy={loading === 'approve'}
                    className="gap-2"
                >
                    {loading === 'approve' ? (
                        <>
                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                            {t('tool.submitting')}
                        </>
                    ) : (
                        t('tool.exitPlanMode.start')
                    )}
                </Button>
            </div>
        </div>
    )
}
