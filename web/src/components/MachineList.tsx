import type { Machine } from '@/types/api'
import { HostBadge } from '@/components/HostBadge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
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

type MachineListProps = {
    machines: Machine[]
    onSelect: (machineId: string) => void
}

export function MachineList(props: MachineListProps) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-3 p-3">
            <div className="text-xs text-[var(--app-hint)]">
                {props.machines.length} {t('misc.online')}
            </div>

            <div className="flex flex-col gap-3">
                {props.machines.map((m) => (
                    <Card
                        key={m.id}
                        className="cursor-pointer"
                        onClick={() => props.onSelect(m.id)}
                    >
                        <CardHeader className="pb-2">
                            <CardTitle className="truncate">{getMachineTitle(m)}</CardTitle>
                            <CardDescription className="truncate">
                                <HostBadge
                                    displayName={m.metadata?.displayName}
                                    host={m.metadata?.host}
                                    platform={m.metadata?.platform}
                                    machineId={m.id}
                                    className="max-w-full"
                                />
                            </CardDescription>
                        </CardHeader>
                    </Card>
                ))}
            </div>
        </div>
    )
}
