import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/entities/machine'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { HostBadge } from '@/entities/machine'
import { usePlatform } from '@/shared/hooks/usePlatform'
import { useSpawnSession } from '@/entities/session/api'
import { formatRunnerSpawnError } from '@/entities/session/lib'
import { useTranslation } from '@/lib/use-translation'

type SessionType = 'simple' | 'worktree'

type SpawnSessionProps = {
    api: ApiClient
    machineId: string
    machine: Machine | null
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}

export function SpawnSession(props: SpawnSessionProps) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const [directory, setDirectory] = useState('')
    const [sessionType, setSessionType] = useState<SessionType>('simple')
    const [worktreeName, setWorktreeName] = useState('')
    const [error, setError] = useState<string | null>(null)
    const { spawnSession, isPending, error: spawnError } = useSpawnSession(props.api)

    const runnerSpawnError = useMemo(
        () => formatRunnerSpawnError(props.machine),
        [props.machine?.runnerState?.lastSpawnError]
    )

    async function spawn() {
        const trimmed = directory.trim()
        if (!trimmed) return

        setError(null)
        try {
            const result = await spawnSession({
                machineId: props.machineId,
                directory: trimmed,
                sessionType,
                worktreeName: sessionType === 'worktree' ? (worktreeName.trim() || undefined) : undefined
            })
            if (result.type === 'success') {
                haptic.notification('success')
                props.onSuccess(result.sessionId)
                return
            }
            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('spawn.error'))
        }
    }

    return (
        <div className="p-3">
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle>{t('spawn.title')}</CardTitle>
                    <CardDescription className="truncate">
                        {props.machine ? (
                            <HostBadge
                                displayName={props.machine.metadata?.displayName}
                                host={props.machine.metadata?.host}
                                platform={props.machine.metadata?.platform}
                                machineId={props.machine.id}
                            />
                        ) : (
                            t('misc.machine')
                        )}
                    </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            placeholder={t('newSession.placeholder')}
                            value={directory}
                            onChange={(e) => setDirectory(e.target.value)}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        />

                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-medium text-[var(--app-hint)]">
                                {t('spawn.sessionType')}
                            </label>
                            <div className="flex flex-col gap-3 text-sm">
                                {(['simple', 'worktree'] as const).map((type) => (
                                    <div key={type} className="flex flex-col gap-2">
                                        {type === 'worktree' ? (
                                            <div className="flex items-start gap-2">
                                                <input
                                                    id="session-type-worktree"
                                                    type="radio"
                                                    name="sessionType"
                                                    value="worktree"
                                                    checked={sessionType === 'worktree'}
                                                    onChange={() => setSessionType('worktree')}
                                                    disabled={isPending}
                                                    className="mt-1 accent-[var(--app-link)]"
                                                />
                                                <div className="flex-1">
                                                    <div className="min-h-[34px] flex items-center">
                                                        {sessionType === 'worktree' ? (
                                                            <input
                                                                type="text"
                                                                placeholder={t('spawn.worktreePlaceholder')}
                                                                value={worktreeName}
                                                                onChange={(e) => setWorktreeName(e.target.value)}
                                                                disabled={isPending}
                                                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-60"
                                                            />
                                                        ) : (
                                                            <label
                                                                htmlFor="session-type-worktree"
                                                                className="capitalize cursor-pointer"
                                                            >
                                                                {t('newSession.type.worktree')}
                                                            </label>
                                                        )}
                                                    </div>
                                                    <span className={`block text-xs text-[var(--app-hint)] ${sessionType === 'worktree' ? 'invisible' : ''}`}>
                                                        {t('spawn.createWorktree')}
                                                    </span>
                                                </div>
                                            </div>
                                        ) : (
                                            <label className="flex items-center gap-2 cursor-pointer min-h-[34px]">
                                                <input
                                                    id="session-type-simple"
                                                    type="radio"
                                                    name="sessionType"
                                                    value="simple"
                                                    checked={sessionType === 'simple'}
                                                    onChange={() => setSessionType('simple')}
                                                    disabled={isPending}
                                                    className="accent-[var(--app-link)]"
                                                />
                                                <span className="capitalize">{t('newSession.type.simple')}</span>
                                                <span className="text-xs text-[var(--app-hint)]">
                                                    {t('spawn.useAsIs')}
                                                </span>
                                            </label>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {runnerSpawnError ? (
                            <div className="text-xs text-red-600">
                                {t('spawn.runnerLastError')}: {runnerSpawnError}
                            </div>
                        ) : null}

                        {(error ?? spawnError) ? (
                            <div className="text-sm text-red-600">
                                {error ?? spawnError}
                            </div>
                        ) : null}

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={props.onCancel}
                                disabled={isPending}
                            >
                                {t('spawn.cancel')}
                            </Button>
                            <Button
                                onClick={spawn}
                                disabled={isPending || !directory.trim()}
                            >
                                {isPending ? t('spawn.creating') : t('spawn.create')}
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
