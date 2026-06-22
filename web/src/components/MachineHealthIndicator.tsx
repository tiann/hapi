import { useId } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import {
    MACHINE_HEALTH_BAR_FILL_CLASS,
    MACHINE_HEALTH_CHIP_CLASS,
    getCpuMetricTooltipLabel,
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
        <span className="inline-flex min-w-[7.5rem] items-center gap-2 whitespace-nowrap">
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
                className="relative h-1.5 w-14 overflow-hidden rounded-full bg-[var(--app-border)]/80"
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

function MachineHealthTooltipBody(props: {
    presentation: MachineHealthPresentation
}) {
    const { t } = useTranslation()
    const { presentation } = props
    const statusKey = `machine.health.status.${presentation.status}` as const

    return (
        <span className="block space-y-1.5">
            <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span className="font-medium">{t('machine.health.tooltip.title')}</span>
                <span className="text-[var(--app-fg)]">{t(statusKey)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-5 gap-y-1">
                {presentation.metrics.map((metric) => (
                    <TooltipMetricStat
                        key={metric.id}
                        metric={metric}
                        label={metric.id === 'cpu'
                            ? getCpuMetricTooltipLabel(presentation.cpuCount, t)
                            : t(`machine.health.metric.${metric.id}`, { n: metric.percent })}
                    />
                ))}
                {presentation.loadDetail ? (
                    <span className="inline-flex min-w-[7.5rem] items-center gap-2 whitespace-nowrap text-[var(--app-hint)]">
                        <span>{t('machine.health.tooltip.loadShort')}</span>
                        <span className="font-semibold tabular-nums text-[var(--app-fg)]">
                            {presentation.loadDetail}
                        </span>
                    </span>
                ) : null}
            </span>
            <span className="block text-[11px] leading-snug text-[var(--app-hint)]">
                {t('machine.health.tooltip.hint')}
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

    const ariaLabel = presentation.metrics.length > 0
        ? presentation.metrics
            .map((metric) => t(`machine.health.aria.${metric.id}`, { n: metric.percent }))
            .join('; ')
        : t('machine.health.aria.unknown')

    const chip = (
        <span
            className={cn(
                'inline-flex rounded-md border',
                compact ? 'flex-row flex-nowrap items-center gap-x-1.5 px-1 py-0.5' : layout === 'inline'
                    ? 'flex-row flex-wrap items-center gap-x-3 gap-y-1 px-1.5 py-1'
                    : 'flex-col gap-0.5 px-1.5 py-1',
                MACHINE_HEALTH_CHIP_CLASS[presentation.overallTone],
                props.className
            )}
            aria-label={ariaLabel}
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
        </span>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={chip}
            side="bottom"
            align="row"
            className="shrink-0"
            tooltipClassName="px-3 py-2"
            revealOnParentFocusClass={props.revealOnParentFocusClass}
        >
            <MachineHealthTooltipBody presentation={presentation} />
        </HoverTooltip>
    )
}
