import * as Popover from '@radix-ui/react-popover'
import type { AgentState } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

type Usage = NonNullable<AgentState['codexUsage']>

export function CodexUsage({ usage }: { usage: Usage }) {
    const { t } = useTranslation()
    const bucket = (value: Usage['ordinary']) => {
        const windows = [value.primary, value.secondary].filter(window => window !== null)
        if (windows.length === 0) return <div>{t('codexUsage.unknown')}</div>
        return windows.map((window, index) => (
            <div key={index}>
                <span>{window.remainingPercent === null
                    ? t('codexUsage.unknown')
                    : t('codexUsage.remaining', { percent: window.remainingPercent })}</span>
                {window.windowDurationMins !== null ? (
                    <span> · {t('codexUsage.window', { minutes: window.windowDurationMins })}</span>
                ) : null}
                {window.resetsAt !== null ? (
                    <div className="text-[var(--app-hint)]">
                        {t('codexUsage.resets', { time: new Date(window.resetsAt * 1000).toLocaleString() })}
                    </div>
                ) : null}
            </div>
        ))
    }
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button type="button" className="shrink-0 rounded-sm text-[10px] text-[var(--app-hint)] focus-visible:outline focus-visible:outline-2" aria-label={t('codexUsage.title')}>
                    {usage.reserve ? '☾ Luna Reserve' : t('codexUsage.title')}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content side="top" sideOffset={6} collisionPadding={8} className="z-50 max-w-[calc(100vw-1rem)] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-xs text-[var(--app-fg)] shadow-lg">
                    <h3 className="mb-2 font-semibold">{t('codexUsage.title')}</h3>
                    <div>{t('codexUsage.ordinary')}</div>
                    {bucket(usage.ordinary)}
                    {usage.reserve ? (
                        <section className="mt-2 border-t border-[var(--app-border)] pt-2">
                            <h4 className="font-semibold">Luna Reserve · GPT-5.6 Luna</h4>
                            {bucket(usage.reserve)}
                        </section>
                    ) : null}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
