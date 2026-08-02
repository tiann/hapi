import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { getMachineTitle } from '@/hooks/useMachineLabels'
import { resolveMachineOsLabel } from '@/lib/machineHealth'
import { queryKeys } from '@/lib/query-keys'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

function MachineRow(props: { api: ApiClient | null; machine: Machine }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)
    const savingRef = useRef(false)

    const displayName = props.machine.metadata?.displayName ?? ''
    const label = getMachineTitle(props.machine)
    const host = props.machine.metadata?.host
    const online = props.machine.active
    const osLabel = resolveMachineOsLabel(props.machine.metadata?.platform)
    const platform = osLabel.kind === 'i18n' ? t(osLabel.key) : osLabel.value

    const renameMutation = useMutation({
        mutationFn: async (next: string) => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.renameMachine(props.machine.id, next)
        },
        onSuccess: () => {
            setEditing(false)
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
        },
        onError: () => setError(t('settings.machines.error')),
    })

    function startEditing() {
        setDraft(displayName)
        setError(null)
        setEditing(true)
    }

    function save() {
        // Disabling the focused input on submit forces a blur, so `save` is
        // reached twice for a single Enter. A ref (not `isPending`, which is a
        // render-timing-dependent closure value) keeps that to one request.
        if (savingRef.current) {
            return
        }
        const next = draft.trim()
        if (next === displayName) {
            setEditing(false)
            return
        }
        savingRef.current = true
        renameMutation.mutate(next, {
            onSettled: () => {
                savingRef.current = false
            },
        })
    }

    return (
        <div className="group px-3 py-3">
            <div className="flex items-center gap-2.5">
                <span
                    role="img"
                    aria-label={online ? t('settings.machines.status.online') : t('settings.machines.status.offline')}
                    title={online ? t('settings.machines.status.online') : t('settings.machines.status.offline')}
                    className={online
                        ? 'h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-500'
                        : 'h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px] border-[var(--app-link-muted)]'}
                />
                <div className="min-w-0 flex-1">
                    {editing ? (
                        <input
                            autoFocus
                            value={draft}
                            maxLength={MACHINE_DISPLAY_NAME_MAX_LENGTH}
                            disabled={renameMutation.isPending}
                            placeholder={host ?? t('settings.machines.namePlaceholder')}
                            aria-label={t('settings.machines.rename', { name: label })}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={save}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault()
                                    save()
                                } else if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setEditing(false)
                                    setError(null)
                                }
                            }}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-60"
                        />
                    ) : (
                        <>
                            {/* The name itself is the tap target. The trailing button is a
                                hover affordance for pointer users and never the only way in,
                                since hover does not exist on touch. */}
                            <button
                                type="button"
                                onClick={startEditing}
                                aria-label={t('settings.machines.rename', { name: label })}
                                className={`block w-full truncate text-left text-sm font-medium ${displayName ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                            >
                                {label}
                            </button>
                            {displayName ? (
                                <div className="mt-0.5 truncate text-xs leading-snug text-[var(--app-hint)]">{host}</div>
                            ) : null}
                        </>
                    )}
                </div>
                <span className="shrink-0 rounded-md bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)]">
                    {platform}
                </span>
                {editing ? null : (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden
                        onClick={startEditing}
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-[var(--app-hint)] opacity-0 transition-opacity hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] group-hover:opacity-100"
                    >
                        {displayName ? t('settings.machines.action.edit') : t('settings.machines.action.name')}
                    </button>
                )}
            </div>
            {error ? <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </div>
    )
}

export default function SettingsMachinesPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { machines } = useMachines(api, true, { includeOffline: true })

    // Online first, then by label, so the machines you can act on lead.
    const sorted = [...machines].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1
        return getMachineTitle(a).localeCompare(getMachineTitle(b))
    })

    return (
        <SettingsPageContent description={t('settings.machines.description')}>
            <SettingsSection title={t('settings.machines.section')}>
                {sorted.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.machines.empty')}</div>
                ) : (
                    sorted.map((machine) => (
                        <MachineRow key={machine.id} api={api} machine={machine} />
                    ))
                )}
            </SettingsSection>
        </SettingsPageContent>
    )
}
