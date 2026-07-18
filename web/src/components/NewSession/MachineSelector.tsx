import type { Machine } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function MachineSelector(props: {
    machines: Machine[]
    knownMachinesCount?: number
    offlineMachinesCount?: number
    machineId: string | null
    isLoading?: boolean
    isDisabled: boolean
    onChange: (machineId: string) => void
}) {
    const { t } = useTranslation()
    const knownMachinesCount = props.knownMachinesCount ?? props.machines.length
    const offlineMachinesCount = props.offlineMachinesCount ?? Math.max(knownMachinesCount - props.machines.length, 0)
    const hasKnownOfflineMachines = !props.isLoading
        && props.machines.length === 0
        && (offlineMachinesCount > 0 || knownMachinesCount > 0)

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.machine')}
            </label>
            <select
                value={props.machineId ?? ''}
                onChange={(e) => props.onChange(e.target.value)}
                disabled={props.isDisabled}
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {props.isLoading && (
                    <option value="">{t('loading.machines')}</option>
                )}
                {!props.isLoading && props.machines.length === 0 && (
                    <option value="">
                        {hasKnownOfflineMachines ? t('misc.noOnlineMachines') : t('misc.noMachines')}
                    </option>
                )}
                {props.machines.map((m) => (
                    <option key={m.id} value={m.id}>
                        {getMachineTitle(m)}
                        {m.metadata?.platform ? ` (${m.metadata.platform})` : ''}
                    </option>
                ))}
            </select>
            {hasKnownOfflineMachines ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-900">
                    <div className="font-medium">{t('misc.noOnlineMachines')}</div>
                    <div>{t('newSession.offlineMachinesHelp')}</div>
                    <code className="mt-1 inline-block rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-amber-950">
                        hapi runner start
                    </code>
                </div>
            ) : null}
        </div>
    )
}
