import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    CREATABLE_AGENT_FLAVORS,
    getPermissionModeOptionsForFlavor,
    type AgentFlavor,
    type PermissionMode
} from '@hapi/protocol'
import type { UpdateHubSettingsRequest } from '@hapi/protocol/apiTypes'
import type { ResolvedPeerSpawnDefaults } from '@hapi/protocol/peerSpawnDefaults'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { CompanionPairing } from '@/components/settings/CompanionPairing'
import { SettingsChoiceGroup, SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { queryKeys } from '@/lib/query-keys'

const locales: ReadonlyArray<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
]

function getNamespace(token: string | null): string | null {
    if (!token) return null
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}

export default function SettingsGeneralPage() {
    const { t, locale, setLocale } = useTranslation()
    const { api, baseUrl, token } = useAppContext()
    const queryClient = useQueryClient()
    const isOwner = getNamespace(token) === 'default'

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
        mutationFn: async (patch: UpdateHubSettingsRequest) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateHubSettings(patch)
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.hubSettings, data)
        },
    })

    const peerDefaults = hubSettingsQuery.data?.peerSpawnDefaults
    const agentOptions = CREATABLE_AGENT_FLAVORS.map((value) => ({ value, label: value }))
    const permissionOptions = getPermissionModeOptionsForFlavor(peerDefaults?.agent).map((option) => ({
        value: option.mode,
        label: option.label
    }))

    function updatePeerSpawnDefaults(next: ResolvedPeerSpawnDefaults) {
        if (hubSettingsMutation.isPending) return
        hubSettingsMutation.mutate({
            peerSpawnDefaults: {
                agent: next.agent,
                permissionMode: next.permissionMode,
                models: next.models
            }
        })
    }

    const currentModel = peerDefaults?.models[peerDefaults.agent] ?? ''

    return (
        <SettingsPageContent description={t('settings.general.description')}>
            <SettingsSection title={t('settings.language.label')}>
                <SettingsChoiceGroup hideLabel label={t('settings.language.label')} value={locale} options={locales} onChange={setLocale} />
            </SettingsSection>
            {isOwner ? (
                <SettingsSection title={t('settings.general.agents.title')} description={t('settings.general.agents.description')}>
                    {hubSettingsQuery.data ? (
                        <>
                            <SettingsSwitch
                                label={t('settings.general.sessionSummaryContract')}
                                description={t('settings.general.sessionSummaryContract.desc')}
                                checked={hubSettingsQuery.data.sessionSummaryContract}
                                onChange={(checked) => {
                                    if (hubSettingsMutation.isPending) return
                                    hubSettingsMutation.mutate({ sessionSummaryContract: checked })
                                }}
                            />
                            <SettingsSwitch
                                label={t('settings.general.sessionSummaryInChat')}
                                description={t('settings.general.sessionSummaryInChat.desc')}
                                checked={hubSettingsQuery.data.sessionSummaryInChat}
                                onChange={(checked) => {
                                    if (hubSettingsMutation.isPending) return
                                    hubSettingsMutation.mutate({ sessionSummaryInChat: checked })
                                }}
                            />
                            {peerDefaults ? (
                                <>
                                    <SettingsChoiceGroup
                                        hideLabel
                                        label={t('settings.general.peerSpawn.agent')}
                                        description={t('settings.general.peerSpawn.agent.desc')}
                                        value={peerDefaults.agent}
                                        options={agentOptions}
                                        columns={5}
                                        onChange={(agent) => {
                                            updatePeerSpawnDefaults({
                                                ...peerDefaults,
                                                agent: agent as AgentFlavor
                                            })
                                        }}
                                    />
                                    <SettingsChoiceGroup
                                        hideLabel
                                        label={t('settings.general.peerSpawn.permissionMode')}
                                        description={t('settings.general.peerSpawn.permissionMode.desc')}
                                        value={peerDefaults.permissionMode}
                                        options={permissionOptions}
                                        columns={4}
                                        onChange={(permissionMode) => {
                                            updatePeerSpawnDefaults({
                                                ...peerDefaults,
                                                permissionMode: permissionMode as PermissionMode
                                            })
                                        }}
                                    />
                                    <SettingsRow label={t('settings.general.peerSpawn.model')} description={t('settings.general.peerSpawn.model.desc')}>
                                        <input
                                            key={`${peerDefaults.agent}:${currentModel}`}
                                            type="text"
                                            defaultValue={currentModel}
                                            onBlur={(event) => {
                                                const model = event.target.value.trim()
                                                if (!model || model === currentModel) return
                                                updatePeerSpawnDefaults({
                                                    ...peerDefaults,
                                                    models: {
                                                        ...peerDefaults.models,
                                                        [peerDefaults.agent]: model
                                                    }
                                                })
                                            }}
                                            className="w-full max-w-xs rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)]"
                                        />
                                    </SettingsRow>
                                </>
                            ) : null}
                        </>
                    ) : null}
                </SettingsSection>
            ) : null}
            <SettingsSection title={t('settings.companion.title')}>
                <div className="px-3 py-3">
                    <CompanionPairing baseUrl={baseUrl} />
                </div>
            </SettingsSection>
        </SettingsPageContent>
    )
}
