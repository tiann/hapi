import { useId } from 'react'
import type { MachineHealthPresentation } from '@/lib/machineHealth'
import { MachineHealthTooltipBody } from '@/components/MachineHealthIndicator'
import { HoverTooltip } from '@/components/HoverTooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export type MachineFilterItem = {
    id: string
    label: string
    sessionCount: number
    healthPresentation: MachineHealthPresentation | null
}

const chipBaseClass = 'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors'
const chipSelectedClass = 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)] font-medium'
const chipIdleClass = 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

function MachineFilterChip(props: {
    machine: MachineFilterItem
    selected: boolean
    onSelect: (id: string) => void
}) {
    const { machine, selected, onSelect } = props
    const tooltipId = useId()
    const hasHealth = machine.healthPresentation && machine.healthPresentation.metrics.length > 0

    // The button carries the pill's padding so the entire visible chip is
    // clickable; when a health popup wraps it, the wrapper only draws the border.
    const button = (
        <button
            type="button"
            onClick={() => onSelect(machine.id)}
            aria-pressed={selected}
            aria-describedby={hasHealth ? tooltipId : undefined}
            title={machine.label}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <span className="max-w-32 truncate">{machine.label}</span>
            <span className="tabular-nums opacity-70">({machine.sessionCount})</span>
        </button>
    )

    if (!hasHealth) {
        return (
            <button
                type="button"
                onClick={() => onSelect(machine.id)}
                aria-pressed={selected}
                title={machine.label}
                className={cn(chipBaseClass, selected ? chipSelectedClass : chipIdleClass)}
            >
                <span className="max-w-32 truncate">{machine.label}</span>
                <span className="tabular-nums opacity-70">({machine.sessionCount})</span>
            </button>
        )
    }

    return (
        // CPU/RAM details live in a hover popup so the chip stays compact;
        // hidden below the md breakpoint (touch devices). The `before:` bridge
        // spans the mt-1 gap so the popup stays open while the pointer enters it.
        <HoverTooltip
            id={tooltipId}
            target={button}
            side="bottom"
            align="start"
            className={cn('shrink-0 rounded-full border transition-colors', selected ? chipSelectedClass : chipIdleClass)}
            tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem] max-md:hidden"
        >
            <MachineHealthTooltipBody presentation={machine.healthPresentation!} />
        </HoverTooltip>
    )
}

export function MachineFilterBar(props: {
    machines: MachineFilterItem[]
    totalCount: number
    value: string | null
    onChange: (id: string | null) => void
}) {
    const { t } = useTranslation()
    return (
        <div
            role="group"
            aria-label={t('sessions.machineFilter.label')}
            className="flex flex-wrap items-center gap-1.5 px-2 pb-2"
        >
            <button
                type="button"
                onClick={() => props.onChange(null)}
                aria-pressed={props.value === null}
                className={cn(chipBaseClass, props.value === null ? chipSelectedClass : chipIdleClass)}
            >
                <span className="truncate">{t('sessions.machineFilter.all')}</span>
                <span className="tabular-nums opacity-70">({props.totalCount})</span>
            </button>
            {props.machines.map((machine) => (
                <MachineFilterChip
                    key={machine.id}
                    machine={machine}
                    selected={props.value === machine.id}
                    onSelect={props.onChange}
                />
            ))}
        </div>
    )
}
