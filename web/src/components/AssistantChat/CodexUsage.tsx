import * as Popover from '@radix-ui/react-popover'
import type { CodexAccountUsage } from '@hapi/protocol/apiTypes'
import { useTranslation } from '@/lib/use-translation'

export function CodexUsage(props: { usage?: CodexAccountUsage | null; model?: string | null }) {
    const { t } = useTranslation()
    const inReserve = props.model === 'gpt-reserve'
    if (!props.usage && !inReserve) return null
    const buckets = [
        { label: t('codex.usage.ordinary'), value: props.usage?.ordinary },
        ...(inReserve ? [{ label: '☾ Luna Reserve', value: props.usage?.reserve }] : [])
    ]
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button type="button" className="shrink-0 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]" aria-label={t('codex.usage.details')}>
                    {inReserve ? '☾ Reserve' : t('codex.usage.label')}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content side="top" align="start" sideOffset={8} className="z-50 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 text-xs shadow-lg">
                    {buckets.map(({ label, value }) => (
                        <div key={label} className="mb-2 last:mb-0">
                            <div className="mb-1 font-medium">{label}</div>
                            {!value?.primary && !value?.secondary ? <div className="text-[var(--app-hint)]">{t('codex.usage.unknown')}</div> : null}
                            {[value?.primary, value?.secondary].map((window, index) => window ? (
                                <div key={index} className="text-[var(--app-hint)]">
                                    {window.windowDurationMins === null ? t('codex.usage.window')
                                        : window.windowDurationMins % 1440 === 0 ? t('codex.usage.days', { value: window.windowDurationMins / 1440 })
                                        : window.windowDurationMins % 60 === 0 ? t('codex.usage.hours', { value: window.windowDurationMins / 60 })
                                        : t('codex.usage.minutes', { value: window.windowDurationMins })}
                                    {' · '}{window.remainingPercent === null ? t('codex.usage.unknown') : t('codex.usage.remaining', { value: window.remainingPercent })}
                                    {window.resetsAt !== null ? <div>{t('codex.usage.resets', { value: new Date(window.resetsAt * 1000).toLocaleString() })}</div> : null}
                                </div>
                            ) : null)}
                        </div>
                    ))}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
