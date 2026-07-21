import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useUpgradeInfo, useSetFleetUpgradePolicy } from '@/hooks/queries/useUpgradeInfo'
import { SettingsChoiceGroup, SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

export default function SettingsAboutPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { info } = useUpgradeInfo(api)
    const setPolicy = useSetFleetUpgradePolicy(api)
    const policy: FleetUpgradePolicy = info?.policy ?? 'auto'

    const policyOptions: ReadonlyArray<{ value: FleetUpgradePolicy; label: string; description?: string }> = [
        { value: 'silent', label: t('settings.about.runnerMgmt.policySilent'), description: t('settings.about.runnerMgmt.policySilentHint') },
        { value: 'alert', label: t('settings.about.runnerMgmt.policyAlert'), description: t('settings.about.runnerMgmt.policyAlertHint') },
        { value: 'auto', label: t('settings.about.runnerMgmt.policyAuto'), description: t('settings.about.runnerMgmt.policyAutoHint') },
    ]

    return (
        <SettingsPageContent title={t('settings.about.title')} description={t('settings.about.description')}>
            <SettingsSection>
                <SettingsRow label={t('settings.about.website')} trailing={
                    <a href="https://hapi.run" target="_blank" rel="noopener noreferrer" className="text-[var(--app-link)] hover:underline">hapi.run</a>
                } />
                <SettingsRow label={t('settings.about.appVersion')} trailing={<span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>} />
                <SettingsRow label={t('settings.about.protocolVersion')} trailing={<span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>} />
            </SettingsSection>
            <SettingsSection title={t('settings.about.runnerMgmt.title')} description={t('settings.about.runnerMgmt.body')}>
                <SettingsChoiceGroup
                    label={t('settings.about.runnerMgmt.policyLabel')}
                    value={policy}
                    options={policyOptions}
                    columns={3}
                    onChange={(value) => setPolicy.mutate(value)}
                />
                <SettingsRow
                    label={t('settings.about.runnerMgmt.optOutLabel')}
                    description={t('settings.about.runnerMgmt.optOutBody')}
                />
            </SettingsSection>
        </SettingsPageContent>
    )
}
