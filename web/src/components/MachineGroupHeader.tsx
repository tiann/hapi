import type { Machine } from '@/types/api'
import { MachineHealthIndicator } from '@/components/MachineHealthIndicator'
import {
    type MachineHealthPresentation,
} from '@/lib/machineHealth'
import { cn } from '@/lib/utils'

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

export function MachineGroupHeader(props: {
    label: string
    sessionCount: number
    collapsed: boolean
    onToggle: () => void
    machine?: Machine
    healthPresentation: MachineHealthPresentation | null
}) {
    const hasHealth = props.healthPresentation && props.healthPresentation.metrics.length > 0

    return (
        <div
            className={cn(
                'group/machine-row relative flex w-full min-w-0 items-center gap-2 px-1 py-1.5 text-left rounded-lg select-none',
                'border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70',
                'transition-colors hover:bg-[var(--app-subtle-bg)]'
            )}
        >
            <button
                type="button"
                onClick={props.onToggle}
                aria-expanded={!props.collapsed}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                <ChevronIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" collapsed={props.collapsed} />
                <MachineIcon className="h-4 w-4 shrink-0 text-[var(--app-link)]/80" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-fg)]" title={props.label}>
                    {props.label}
                </span>
            </button>
            {hasHealth ? (
                <MachineHealthIndicator
                    presentation={props.healthPresentation!}
                    layout="inline"
                    compact
                    className="shrink-0"
                />
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--app-hint)]">
                ({props.sessionCount})
            </span>
        </div>
    )
}
