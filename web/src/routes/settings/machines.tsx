import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MACHINE_DISPLAY_NAME_MAX_LENGTH } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { getMachineTitle } from '@/hooks/useMachineLabels'
import { queryKeys } from '@/lib/query-keys'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

function MachineRow(props: { api: ApiClient | null; machine: Machine }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)
    const savingRef = useRef(false)

    const label = getMachineTitle(props.machine)
    const host = props.machine.metadata?.host
    const platform = props.machine.metadata?.platform
    const subtitle = [host, platform].filter(Boolean).join(' · ')

    const renameMutation = useMutation({
        mutationFn: async (displayName: string) => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.renameMachine(props.machine.id, displayName)
        },
        onSuccess: () => {
            setEditing(false)
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.machines })
        },
        onError: () => setError(t('settings.machines.error')),
    })

    function startEditing() {
        setDraft(props.machine.metadata?.displayName ?? '')
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
        if (next === (props.machine.metadata?.displayName ?? '')) {
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
        <div className="px-3 py-3">
            <div className="flex min-h-9 items-center justify-between gap-3">
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
                        <button
                            type="button"
                            onClick={startEditing}
                            aria-label={t('settings.machines.rename', { name: label })}
                            className="block w-full truncate text-left text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-link)]"
                        >
                            {label}
                        </button>
                    )}
                    {subtitle ? (
                        <div className="mt-0.5 truncate text-xs leading-snug text-[var(--app-hint)]">{subtitle}</div>
                    ) : null}
                </div>
            </div>
            {error ? <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </div>
    )
}

export default function SettingsMachinesPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)

    return (
        <SettingsPageContent description={t('settings.machines.description')}>
            <SettingsSection title={t('settings.machines.section')}>
                {machines.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.machines.empty')}</div>
                ) : (
                    machines.map((machine) => (
                        <MachineRow key={machine.id} api={api} machine={machine} />
                    ))
                )}
            </SettingsSection>
        </SettingsPageContent>
    )
}
