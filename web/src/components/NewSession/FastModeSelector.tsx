import { useTranslation } from '@/lib/use-translation'
import type { NewSessionServiceTier } from './types'
import { SelectControl } from '@/components/ui/select-control'

export type { NewSessionServiceTier }

export function FastModeSelector(props: {
    fastAvailable?: boolean
    ultrafastAvailable?: boolean
    availabilityUnverified?: boolean
    keepExistingTier?: boolean
    verifySavedUltrafastOnLaunch?: boolean
    visible: boolean
    value: NewSessionServiceTier | 'default'
    isDisabled: boolean
    onChange: (value: NewSessionServiceTier | 'default') => void
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
                onChange={(e) => props.onChange(e.target.value as NewSessionServiceTier | 'default')}
                disabled={props.isDisabled}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="default">{props.keepExistingTier ? 'Keep existing tier' : 'Account default'}</option>
                <option value="standard">{t('misc.fastModeStandard')}</option>
                {(props.fastAvailable !== false || props.value === 'fast') && <option value="fast" disabled={props.fastAvailable === false}>{t('misc.fastModeFast')}</option>}
                {(props.ultrafastAvailable || props.value === 'ultrafast') && <option value="ultrafast" disabled={!props.ultrafastAvailable}>{t('misc.fastModeUltrafast')}</option>}
            </SelectControl>
            {props.verifySavedUltrafastOnLaunch ? <p role="status" className="text-xs text-[var(--app-hint)]">The current catalog does not list Ultrafast for this model. Codex will verify it when starting the session.</p> : null}
            {props.availabilityUnverified ? <p role="status" className="text-xs text-[var(--app-hint)]">
                {props.keepExistingTier
                    ? 'Service tier availability could not be verified. Choose Standard to replace the existing tier.'
                    : 'Service tier availability could not be verified. You can choose Standard or Account default.'}
            </p> : null}
        </div>
    )
}
