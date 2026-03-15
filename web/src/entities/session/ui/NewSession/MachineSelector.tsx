import type { Machine } from '@/types/api'
import { getHostDisplayName } from '@/shared/lib/host-utils'
import { useTranslation } from '@/lib/use-translation'

function getMachineTitle(machine: Machine): string {
    return getHostDisplayName({
        displayName: machine.metadata?.displayName,
        host: machine.metadata?.host,
        platform: machine.metadata?.platform,
        machineId: machine.id,
    }) ?? machine.id.slice(0, 8)
}

type MachineSelectorProps = {
    machines: Machine[]
    machineId: string | null
    isLoading?: boolean
    isDisabled: boolean
    onChange: (machineId: string) => void
}

export function MachineSelector(props: MachineSelectorProps) {
    const { t } = useTranslation()

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
                    <option value="">{t('misc.noMachines')}</option>
                )}
                {props.machines.map((m) => (
                    <option key={m.id} value={m.id}>
                        {getMachineTitle(m)}
                    </option>
                ))}
            </select>
        </div>
    )
}
