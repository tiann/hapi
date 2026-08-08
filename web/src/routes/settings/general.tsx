import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { isDefaultNamespaceToken } from '@/lib/tokenNamespace'
import { CompanionPairing } from '@/components/settings/CompanionPairing'
import { SettingsChoiceGroup, SettingsLinkRow, SettingsPageContent, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { queryKeys } from '@/lib/query-keys'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { api, baseUrl, token } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const isOwner = isDefaultNamespaceToken(token)
    const showRunnerManagement = isOwner

    const hubSettingsQuery = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHubSettings()
        },
        enabled: Boolean(api) && isOwner,
        staleTime: 30_000,
        retry: false,
    })

    const hubSettingsMutation = useMutation({
        mutationFn: async (sessionSummaryContract: boolean) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateHubSettings({ sessionSummaryContract })
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.hubSettings, data)
        },
    })

    return (
        <SettingsPageContent description={t('settings.general.description')}>
            <SettingsSection title={t('settings.language.label')}>
                <SettingsChoiceGroup hideLabel label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            {isOwner ? (
                <SettingsSection title={t('settings.general.agents.title')} description={t('settings.general.agents.description')}>
                    {hubSettingsQuery.data ? (
                        <SettingsSwitch
                            label={t('settings.general.sessionSummaryContract')}
                            description={t('settings.general.sessionSummaryContract.desc')}
                            checked={hubSettingsQuery.data.sessionSummaryContract}
                            onChange={(checked) => {
                                if (hubSettingsMutation.isPending) return
                                hubSettingsMutation.mutate(checked)
                            }}
                        />
                    ) : null}
                </SettingsSection>
            ) : null}
            <SettingsSection title={t('settings.companion.title')}>
                <div className="px-3 py-3">
                    <CompanionPairing baseUrl={baseUrl} />
                </div>
            </SettingsSection>
            {showRunnerManagement ? (
                <SettingsSection>
                    <SettingsLinkRow
                        label={t('settings.runnerMgmt.title')}
                        description={t('settings.runnerMgmt.linkHint')}
                        onClick={() => navigate({ to: '/settings/general/runners' })}
                    />
                </SettingsSection>
            ) : null}
        </SettingsPageContent>
    )
}
