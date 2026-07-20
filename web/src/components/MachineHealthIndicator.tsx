import { useEffect, useId, useRef, useState } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import {
    MACHINE_HEALTH_BAR_FILL_CLASS,
    MACHINE_HEALTH_CHIP_CLASS,
    type MachineHealthMetricPresentation,
    type MachineHealthPresentation
} from '@/lib/machineHealth'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function HealthMeterBar(props: {
    label: string
    percent: number
    tone: MachineHealthPresentation['overallTone']
    layout: 'stack' | 'inline'
    compact?: boolean
}) {
    const barWidthClass = props.compact ? 'w-8' : props.layout === 'inline' ? 'w-14' : 'w-11'
    const labelWidthClass = props.compact ? 'w-5 text-[8px]' : 'w-6 text-[9px]'

    return (
        <div className="flex items-center gap-0.5 min-w-0">
            <span className={cn('shrink-0 font-semibold uppercase tracking-wide text-[var(--app-hint)]', labelWidthClass)}>
                {props.label}
            </span>
            <div
                className={cn(
                    'relative h-1.5 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]/80',
                    barWidthClass
                )}
                aria-hidden="true"
            >
                <div
                    className={cn('h-full rounded-full transition-[width]', MACHINE_HEALTH_BAR_FILL_CLASS[props.tone])}
                    style={{ width: `${Math.max(4, Math.min(100, props.percent))}%` }}
                />
            </div>
            {props.layout === 'inline' && !props.compact ? (
                <span className="w-7 shrink-0 text-[10px] tabular-nums text-[var(--app-fg)]/80">
                    {props.percent}%
                </span>
            ) : null}
        </div>
    )
}

function TooltipMetricStat(props: {
    metric: MachineHealthMetricPresentation
    label: string
}) {
    return (
        <span className="grid grid-cols-[3.75rem_2.25rem_minmax(3.5rem,1fr)] items-center gap-x-1 whitespace-nowrap">
            <span className="text-[var(--app-hint)]">{props.label}</span>
            <span
                className={cn(
                    'font-semibold tabular-nums',
                    props.metric.tone !== 'ok' ? 'text-[var(--app-fg)]' : 'text-[var(--app-fg)]/90'
                )}
            >
                {props.metric.percent}%
            </span>
            <span
                className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-border)]/80"
                aria-hidden="true"
            >
                <span
                    className={cn('block h-full rounded-full', MACHINE_HEALTH_BAR_FILL_CLASS[props.metric.tone])}
                    style={{ width: `${Math.max(4, Math.min(100, props.metric.percent))}%` }}
                />
            </span>
        </span>
    )
}

function MachineHealthHint() {
    const { t } = useTranslation()
    const tooltipId = useId()
    const [clickOpen, setClickOpen] = useState(false)
    const containerRef = useRef<HTMLSpanElement>(null)

    useEffect(() => {
        if (!clickOpen) return

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setClickOpen(false)
            }
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }, [clickOpen])

    const target = (
        <button
            type="button"
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[9px] font-semibold leading-none text-[var(--app-hint)]"
            aria-label={t('machine.health.tooltip.hint')}
            aria-expanded={clickOpen}
            aria-controls={tooltipId}
            onClick={(event) => {
                event.stopPropagation()
                if (clickOpen) {
                    event.currentTarget.blur()
                }
                setClickOpen((open) => !open)
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    setClickOpen(false)
                }
            }}
        >
            ?
        </button>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={target}
            side="bottom"
            align="start"
            open={clickOpen}
            containerRef={containerRef}
            hoverGroup="help"
            tooltipClassName="pointer-events-auto w-56"
        >
            {t('machine.health.tooltip.hint')}
        </HoverTooltip>
    )
}

function MachineHealthTooltipBody(props: {
    presentation: MachineHealthPresentation
}) {
    const { t } = useTranslation()
    const { presentation } = props
    const statusKey = `machine.health.status.${presentation.status}` as const

    return (
        <span className="block space-y-1.5">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="inline-flex items-center gap-1 font-medium">
                    {t('machine.health.tooltip.title')}
                    <MachineHealthHint />
                </span>
                <span className="text-right text-[var(--app-fg)]">{t(statusKey)}</span>
            </span>
            <span className="block space-y-1">
                {presentation.metrics.map((metric) => (
                    <TooltipMetricStat
                        key={metric.id}
                        metric={metric}
                        label={t(`machine.health.metric.${metric.id}`, { n: metric.percent })}
                    />
                ))}
                {presentation.loadDetail ? (
                    <span className="grid grid-cols-[3.75rem_1fr] items-center gap-x-1 whitespace-nowrap text-[var(--app-hint)]">
                        <span>{t('machine.health.tooltip.loadShort')}</span>
                        <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                            {presentation.loadDetail}
                        </span>
                    </span>
                ) : null}
                {presentation.uptimeDetail ? (
                    <span className="grid grid-cols-[3.75rem_1fr] items-center gap-x-1 whitespace-nowrap text-[var(--app-hint)]">
                        <span>{t('machine.health.tooltip.uptimeShort')}</span>
                        <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                            {presentation.uptimeDetail}
                        </span>
                    </span>
                ) : null}
            </span>
        </span>
    )
}

export function MachineHealthIndicator(props: {
    presentation: MachineHealthPresentation
    className?: string
    layout?: 'stack' | 'inline'
    compact?: boolean
    tooltipId?: string
    revealOnParentFocusClass?: string
}) {
    const { t } = useTranslation()
    const generatedTooltipId = useId()
    const tooltipId = props.tooltipId ?? generatedTooltipId
    const { presentation, layout = 'stack', compact = false } = props
    const [clickOpen, setClickOpen] = useState(false)
    const containerRef = useRef<HTMLSpanElement>(null)

    useEffect(() => {
        if (!clickOpen) return

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setClickOpen(false)
            }
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }, [clickOpen])

    const ariaLabel = presentation.metrics.length > 0
        ? presentation.metrics
            .map((metric) => t(`machine.health.aria.${metric.id}`, { n: metric.percent }))
            .join('; ')
        : t('machine.health.aria.unknown')

    const chip = (
        <button
            type="button"
            className={cn(
                'inline-flex rounded-md border',
                compact ? 'flex-row flex-nowrap items-center gap-x-1.5 px-1 py-0.5' : layout === 'inline'
                    ? 'flex-row flex-wrap items-center gap-x-3 gap-y-1 px-1.5 py-1'
                    : 'flex-col gap-0.5 px-1.5 py-1',
                MACHINE_HEALTH_CHIP_CLASS[presentation.overallTone],
                props.className
            )}
            aria-label={ariaLabel}
            aria-describedby={tooltipId}
            aria-expanded={clickOpen}
            aria-controls={tooltipId}
            onClick={(event) => {
                event.stopPropagation()
                if (clickOpen) {
                    event.currentTarget.blur()
                }
                setClickOpen((open) => !open)
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    setClickOpen(false)
                }
            }}
        >
            {presentation.metrics.map((metric) => (
                <HealthMeterBar
                    key={metric.id}
                    label={metric.shortLabel}
                    percent={metric.percent}
                    tone={metric.tone}
                    layout={layout}
                    compact={compact}
                />
            ))}
        </button>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={chip}
            side="bottom"
            align="end"
            className="shrink-0"
            tooltipClassName="pointer-events-auto before:absolute before:inset-x-0 before:-top-1 before:h-1 before:content-[''] px-3 py-2 min-w-[16rem]"
            revealOnParentFocusClass={props.revealOnParentFocusClass}
            open={clickOpen}
            containerRef={containerRef}
        >
            <MachineHealthTooltipBody presentation={presentation} />
        </HoverTooltip>
    )
}
