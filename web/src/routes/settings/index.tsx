import { useTranslation } from '@/lib/use-translation'
import { SettingsNav } from '@/components/settings/SettingsNav'
import SettingsDisplayPage from './display'

export default function SettingsHubPage() {
    const { t } = useTranslation()
    return (
        <>
            <div className="lg:hidden">
                <div className="px-3 pb-2 pt-4 text-sm text-[var(--app-hint)]">{t('settings.hub.description')}</div>
                <SettingsNav mobile />
            </div>
            <div className="hidden lg:block">
                <SettingsDisplayPage />
            </div>
        </>
    )
}
