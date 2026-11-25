import { useTranslation } from '@/lib/use-translation'
import type { NewSessionServiceTier } from './types'
import { SelectControl } from '@/components/ui/select-control'

export type { NewSessionServiceTier }

export function FastModeSelector(props: {
    visible: boolean
    value: NewSessionServiceTier
    isDisabled: boolean
    onChange: (value: NewSessionServiceTier) => void
}) {
    const { t } = useTranslation()

    if (!props.visible) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.fastMode')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <SelectControl
                aria-label={t('newSession.fastMode')}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as NewSessionServiceTier)}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="standard">{t('misc.fastModeStandard')}</option>
                <option value="fast">{t('misc.fastModeFast')}</option>
            </SelectControl>
        </div>
    )
}
