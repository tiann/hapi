import { useId } from 'react'
import { HoverTooltip } from '@/components/HoverTooltip'
import {
    MACHINE_HEALTH_BAR_FILL_CLASS,
    MACHINE_HEALTH_CHIP_CLASS,
    type MachineHealthPresentation
} from '@/lib/machineHealth'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function HealthMeterBar(props: {
    label: string
    percent: number
    tone: MachineHealthPresentation['overallTone']
}) {
    return (
        <div className="flex items-center gap-1 min-w-0">
            <span className="w-6 shrink-0 text-[9px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.label}
            </span>
            <div
                className="relative h-1.5 w-11 shrink-0 overflow-hidden rounded-full bg-[var(--app-border)]/80"
                aria-hidden="true"
            >
                <div
                    className={cn('h-full rounded-full transition-[width]', MACHINE_HEALTH_BAR_FILL_CLASS[props.tone])}
                    style={{ width: `${Math.max(4, Math.min(100, props.percent))}%` }}
                />
            </div>
        </div>
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
            <span className="block font-medium">{t('machine.health.tooltip.title')}</span>
            <span className="block text-[var(--app-fg)]">{t(statusKey)}</span>
            {presentation.metrics.map((metric) => (
                <span key={metric.id} className="flex items-center justify-between gap-3 text-[var(--app-hint)]">
                    <span>{t(`machine.health.metric.${metric.id}`, { n: metric.percent })}</span>
                    <span className={cn('font-medium tabular-nums', metric.tone !== 'ok' && 'text-[var(--app-fg)]')}>
                        {metric.percent}%
                    </span>
                </span>
            ))}
            {presentation.loadDetail ? (
                <span className="block text-[var(--app-hint)]">
                    {t('machine.health.tooltip.load', { value: presentation.loadDetail })}
                </span>
            ) : null}
            <span className="block text-[var(--app-hint)]">{t('machine.health.tooltip.hint')}</span>
        </span>
    )
}

export function MachineHealthIndicator(props: {
    presentation: MachineHealthPresentation
    className?: string
}) {
    const { t } = useTranslation()
    const tooltipId = useId()
    const { presentation } = props

    const ariaLabel = presentation.metrics.length > 0
        ? presentation.metrics
            .map((metric) => t(`machine.health.aria.${metric.id}`, { n: metric.percent }))
            .join('; ')
        : t('machine.health.aria.unknown')

    const chip = (
        <span
            className={cn(
                'inline-flex flex-col gap-0.5 rounded-md border px-1.5 py-1',
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
                />
            ))}
        </span>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={chip}
            side="bottom"
            align="end"
            className="shrink-0"
        >
            <MachineHealthTooltipBody presentation={presentation} />
        </HoverTooltip>
    )
}
