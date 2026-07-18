import { isMachineCapabilitySkewed } from '@hapi/protocol/runnerCapabilities'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

export function machineDisplayHost(machine: Machine): string {
    return machine.metadata?.displayName
        ?? machine.metadata?.host
        ?? machine.id
}

export function listSkewedMachines(machines: Machine[]): Machine[] {
    return machines.filter((machine) => (
        machine.active
        && isMachineCapabilitySkewed(machine.metadata?.capabilities)
    ))
}

/**
 * Persistent, non-dismissible banner when any online machine is missing
 * hub-required runner capabilities (#1084).
 */
export function RunnerVersionSkewBanner({ topClassName }: { topClassName?: string } = {}) {
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()
    const skewed = listSkewedMachines(machines)

    if (skewed.length === 0) {
        return null
    }

    const topClass = topClassName ?? (isOnline ? 'top-2' : 'top-10')

    return (
        <div
            data-testid="runner-version-skew-banner"
            role="alert"
            className={`fixed left-4 right-4 z-50 space-y-2 ${topClass}`}
        >
            {skewed.map((machine) => {
                const host = machineDisplayHost(machine)
                const version = machine.metadata?.happyCliVersion
                return (
                    <div
                        key={machine.id}
                        className="rounded-lg border-2 border-amber-500 bg-amber-50 p-4 shadow-lg dark:bg-amber-950/90"
                        data-testid={`runner-version-skew-banner-${machine.id}`}
                    >
                        <p className="text-sm font-semibold text-amber-950 dark:text-amber-50">
                            {t('runner.skew.banner.title', { host })}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                            {version
                                ? t('runner.skew.banner.body', { host, version })
                                : t('runner.skew.banner.bodyUnknownVersion', { host })}
                        </p>
                    </div>
                )
            })}
        </div>
    )
}
