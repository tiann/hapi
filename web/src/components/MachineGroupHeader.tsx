import { useId } from 'react'
import type { Machine } from '@/types/api'
import { MACHINE_ROW_TOOLTIP_FOCUS_CLASS } from '@/components/HoverTooltip'
import { MachineHealthIndicator } from '@/components/MachineHealthIndicator'
import {
    getMachineHost,
    getMachinePlatform,
    resolveMachineOsLabel,
    shouldShowMachineHostSubtitle,
    type MachineHealthPresentation,
} from '@/lib/machineHealth'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function MachineIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
                props.className,
                'transition-transform duration-200',
                props.collapsed ? '' : 'rotate-90'
            )}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function formatOsLabel(
    osLabel: ReturnType<typeof resolveMachineOsLabel>,
    t: (key: string) => string
): string {
    if (osLabel.kind === 'raw') {
        return osLabel.value
    }
    return t(osLabel.key)
}

export function MachineGroupHeader(props: {
    label: string
    sessionCount: number
    collapsed: boolean
    onToggle: () => void
    machine?: Machine
    healthPresentation: MachineHealthPresentation | null
}) {
    const { t } = useTranslation()
    const healthTooltipId = useId()
    const platform = getMachinePlatform(props.machine)
    const host = getMachineHost(props.machine)
    const osLabel = resolveMachineOsLabel(platform)
    const osText = formatOsLabel(osLabel, t)
    const showHost = shouldShowMachineHostSubtitle(props.label, host)
    const machineMeta = showHost && host ? `${osText} · ${host}` : osText
    const hasHealth = props.healthPresentation && props.healthPresentation.metrics.length > 0

    return (
        <button
            type="button"
            onClick={props.onToggle}
            aria-describedby={hasHealth ? healthTooltipId : undefined}
            className={cn(
                'group/machine-row relative flex w-full min-w-0 items-center gap-2 px-1 py-1.5 text-left rounded-lg select-none',
                'border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70',
                'transition-colors hover:bg-[var(--app-subtle-bg)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
            )}
        >
            <ChevronIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" collapsed={props.collapsed} />
            <MachineIcon className="h-4 w-4 shrink-0 text-[var(--app-link)]/80" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-fg)]">
                {props.label}
            </span>
            <span
                className="min-w-0 max-w-[8rem] shrink truncate text-[11px] text-[var(--app-hint)]"
                title={machineMeta}
            >
                {machineMeta}
            </span>
            {hasHealth ? (
                <MachineHealthIndicator
                    presentation={props.healthPresentation!}
                    layout="inline"
                    compact
                    className="shrink-0"
                    tooltipId={healthTooltipId}
                    revealOnParentFocusClass={MACHINE_ROW_TOOLTIP_FOCUS_CLASS}
                />
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                ({props.sessionCount})
            </span>
        </button>
    )
}
