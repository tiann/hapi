import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useUpgradeInfo, useSetFleetUpgradePolicy } from '@/hooks/queries/useUpgradeInfo'
import { SettingsChoiceGroup, SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { api } = useAppContext()
    const { info } = useUpgradeInfo(api)
    const setPolicy = useSetFleetUpgradePolicy(api)
    const policy: FleetUpgradePolicy = info?.policy ?? 'auto'

    const policyOptions: ReadonlyArray<{ value: FleetUpgradePolicy; label: string; description?: string }> = [
        { value: 'silent', label: t('settings.general.runnerMgmt.policySilent'), description: t('settings.general.runnerMgmt.policySilentHint') },
        { value: 'alert', label: t('settings.general.runnerMgmt.policyAlert'), description: t('settings.general.runnerMgmt.policyAlertHint') },
        { value: 'auto', label: t('settings.general.runnerMgmt.policyAuto'), description: t('settings.general.runnerMgmt.policyAutoHint') },
    ]

    return (
        <SettingsPageContent title={t('settings.general.title')} description={t('settings.general.description')}>
            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            <SettingsSection title={t('settings.general.runnerMgmt.title')} description={t('settings.general.runnerMgmt.body')}>
                <SettingsChoiceGroup
                    label={t('settings.general.runnerMgmt.policyLabel')}
                    value={policy}
                    options={policyOptions}
                    columns={3}
                    onChange={(value) => setPolicy.mutate(value)}
                />
                <SettingsRow
                    label={t('settings.general.runnerMgmt.optOutLabel')}
                    description={t('settings.general.runnerMgmt.optOutBody')}
                />
            </SettingsSection>
        </SettingsPageContent>
    )
}
