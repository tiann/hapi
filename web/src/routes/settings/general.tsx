import { useNavigate } from '@tanstack/react-router'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { SettingsChoiceGroup, SettingsLinkRow, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const navigate = useNavigate()

    return (
        <SettingsPageContent title={t('settings.general.title')} description={t('settings.general.description')}>
            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            <SettingsSection>
                <SettingsLinkRow
                    label={t('settings.runnerMgmt.title')}
                    description={t('settings.runnerMgmt.linkHint')}
                    onClick={() => navigate({ to: '/settings/general/runners' })}
                />
            </SettingsSection>
        </SettingsPageContent>
    )
}
