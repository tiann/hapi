import type { Machine } from '@/types/api'
import { cliBinaryUpdatedOnDisk } from '@hapi/protocol/runnerCapabilities'
import {
    DEFAULT_FLEET_UPGRADE_POLICY,
    machineTrailsUpgradeOffer,
    type FleetUpgradePolicy,
    type HubUpgradeOffer,
} from '@hapi/protocol/upgradeChannel'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import { useAppContext } from '@/lib/app-context'
import { useUpgradeInfo } from '@/hooks/queries/useUpgradeInfo'

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

/** Exported for tests — same predicate family as RunnerVersionSkewBanner. */
export function machineNeedsUpdateLabel(
    machine: Machine,
    offer: HubUpgradeOffer | null | undefined,
    policy: FleetUpgradePolicy,
): boolean {
    if (policy === 'silent' || !offer) {
        return false
    }
    if (!machine.active) {
        return false
    }
    const handoffDisabled = machine.metadata?.versionHandoffDisabled === true
    const trails = machineTrailsUpgradeOffer(
        offer,
        machine.metadata?.happyCliVersion,
        machine.metadata?.capabilities,
        machine.metadata?.cliArtifactGeneration,
        { ignoreGenerationDrift: handoffDisabled },
    ) || (handoffDisabled && cliBinaryUpdatedOnDisk(machine.metadata))
    if (!trails) {
        return false
    }
    // Keep labels under auto: hub only toasts upgrade_failed and does not expose
    // per-machine in-flight/failed state, so hiding self-upgrade-capable hosts
    // would leave permanent failures without a recovery cue.
    return true
}

export function getMachineOptionLabel(
    machine: Machine,
    offer: HubUpgradeOffer | null | undefined,
    policy: FleetUpgradePolicy,
    updateRequiredLabel: string,
): string {
    const title = getMachineTitle(machine)
    const platform = machine.metadata?.platform ? ` (${machine.metadata.platform})` : ''
    const version = machine.metadata?.happyCliVersion
        ? ` · CLI ${machine.metadata.happyCliVersion}`
        : ''
    const skew = machineNeedsUpdateLabel(machine, offer, policy)
        ? ` · ${updateRequiredLabel}`
        : ''
    return `${title}${platform}${version}${skew}`
}

export function MachineSelector(props: {
    machines: Machine[]
    machineId: string | null
    isLoading?: boolean
    isDisabled: boolean
    onChange: (machineId: string) => void
}) {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { info } = useUpgradeInfo(api)
    const offer = info?.offer ?? null
    const policy: FleetUpgradePolicy = info?.policy ?? DEFAULT_FLEET_UPGRADE_POLICY

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.machine')}
            </label>
            <SelectControl
                value={props.machineId ?? ''}
                onChange={(e) => props.onChange(e.target.value)}
                disabled={props.isDisabled}
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {props.isLoading && (
                    <option value="">{t('loading.machines')}</option>
                )}
                {!props.isLoading && props.machines.length === 0 && (
                    <option value="">{t('misc.noMachines')}</option>
                )}
                {props.machines.map((m) => (
                    <option key={m.id} value={m.id}>
                        {getMachineOptionLabel(m, offer, policy, t('runner.skew.updateRequired'))}
                    </option>
                ))}
            </SelectControl>
        </div>
    )
}
