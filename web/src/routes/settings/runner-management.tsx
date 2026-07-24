import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import { DEFAULT_FLEET_UPGRADE_POLICY } from '@hapi/protocol/upgradeChannel'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useUpgradeInfo, useSetFleetUpgradePolicy } from '@/hooks/queries/useUpgradeInfo'
import { SettingsChoiceGroup, SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'

export default function SettingsRunnerManagementPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { info } = useUpgradeInfo(api)
    const setPolicy = useSetFleetUpgradePolicy(api)
    const policy: FleetUpgradePolicy = info?.policy ?? DEFAULT_FLEET_UPGRADE_POLICY

    const policyOptions: ReadonlyArray<{ value: FleetUpgradePolicy; label: string; description?: string }> = [
        { value: 'silent', label: t('settings.runnerMgmt.policySilent'), description: t('settings.runnerMgmt.policySilentHint') },
        { value: 'alert', label: t('settings.runnerMgmt.policyAlert'), description: t('settings.runnerMgmt.policyAlertHint') },
        { value: 'auto', label: t('settings.runnerMgmt.policyAuto'), description: t('settings.runnerMgmt.policyAutoHint') },
    ]

    return (
        <SettingsPageContent title={t('settings.runnerMgmt.title')} description={t('settings.runnerMgmt.body')}>
            <SettingsSection>
                <SettingsChoiceGroup
                    label={t('settings.runnerMgmt.policyLabel')}
                    value={policy}
                    options={policyOptions}
                    columns={3}
                    onChange={(value) => setPolicy.mutate(value)}
                />
                <SettingsRow
                    label={t('settings.runnerMgmt.optOutLabel')}
                    description={t('settings.runnerMgmt.optOutBody')}
                />
            </SettingsSection>
        </SettingsPageContent>
    )
}
