import type { Machine } from '@/types/api'
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
    const platform = getMachinePlatform(props.machine)
    const host = getMachineHost(props.machine)
    const osLabel = resolveMachineOsLabel(platform)
    const osText = formatOsLabel(osLabel, t)
    const showHost = shouldShowMachineHostSubtitle(props.label, host)
    const hasHealth = props.healthPresentation && props.healthPresentation.metrics.length > 0

    return (
        <button
            type="button"
            onClick={props.onToggle}
            className={cn(
                'relative w-full rounded-lg border text-left transition-colors select-none',
                'border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70',
                'hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
            )}
        >
            <div className="flex items-start gap-2 px-2.5 py-2">
                <ChevronIcon
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-hint)]"
                    collapsed={props.collapsed}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        <MachineIcon className="h-4 w-4 shrink-0 text-[var(--app-link)]/80" />
                        <span className="truncate text-sm font-semibold text-[var(--app-fg)]">
                            {props.label}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                            {t('machine.header.sessionCount', { n: props.sessionCount })}
                        </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-6">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                            <span className="font-medium text-[var(--app-fg)]/85">{osText}</span>
                            {showHost && host ? (
                                <>
                                    <span aria-hidden="true">·</span>
                                    <span className="truncate">{host}</span>
                                </>
                            ) : null}
                        </span>
                        {hasHealth ? (
                            <MachineHealthIndicator
                                presentation={props.healthPresentation!}
                                layout="inline"
                                className="ml-auto"
                            />
                        ) : null}
                    </div>
                </div>
            </div>
        </button>
    )
}
