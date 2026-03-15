import { useTranslation } from '@/lib/use-translation'

export function YoloToggle(props: {
    yoloMode: boolean
    isDisabled: boolean
    onToggle: (value: boolean) => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.yolo')}
            </label>
            <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                    <span className="text-sm text-[var(--app-fg)]">
                        {t('newSession.yolo.title')}
                    </span>
                    <span className="text-xs text-[var(--app-hint)]">
                        {t('newSession.yolo.desc')}
                    </span>
                </div>
                <label className="relative inline-flex h-5 w-9 items-center">
                    <input
                        type="checkbox"
                        checked={props.yoloMode}
                        onChange={(e) => props.onToggle(e.target.checked)}
                        disabled={props.isDisabled}
                        className="peer sr-only"
                    />
                    <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
                    <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
                </label>
            </div>
        </div>
    )
}
