import { useTranslation, type Locale } from '@/lib/use-translation'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    return (
        <SettingsPageContent title={t('settings.general.title')} description={t('settings.general.description')}>
            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
