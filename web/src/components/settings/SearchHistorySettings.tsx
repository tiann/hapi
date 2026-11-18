import { useSearchHistory } from '@/lib/search-history'
import { useTranslation } from '@/lib/use-translation'
import { SettingsSection, SettingsSwitch } from './SettingsPrimitives'

export function SearchHistorySettings() {
    const { state, setEnabled, clear } = useSearchHistory()
    const { t } = useTranslation()
    const hasHistory = state.sessions.length + state.files.length + state.outlines.length > 0
    return <SettingsSection title={t('searchHistory.title')} description={t('searchHistory.local')}>
        <SettingsSwitch label={t('searchHistory.title')} description={t('searchHistory.description')} checked={state.enabled} onChange={setEnabled} />
        <button type="button" onClick={() => clear()} disabled={!hasHistory}
            className="min-h-12 w-full px-3 py-3 text-left text-sm text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40">
            {t('searchHistory.clearAll')}
        </button>
    </SettingsSection>
}
