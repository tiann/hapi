import { useQuery } from '@tanstack/react-query'
import { StorageUsagePie } from '@/components/settings/StorageUsagePie'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { formatFileSize } from '@/lib/file-metadata'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export default function SettingsStoragePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const query = useQuery({
        queryKey: queryKeys.sqliteStorage,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSqliteStorageUsage()
        },
        enabled: Boolean(api),
        staleTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    })

    return (
        <SettingsPageContent description={t('settings.storage.description')}>
            {query.isLoading || query.error ? (
                <SettingsSection>
                    {query.isLoading ? <SettingsRow label={t('settings.storage.loading')} /> : null}
                    {query.error ? (
                        <SettingsRow
                            label={t('settings.storage.error')}
                            description={query.error instanceof Error ? query.error.message : undefined}
                        />
                    ) : null}
                </SettingsSection>
            ) : null}
            {query.data ? (
                <StorageUsagePie
                    usage={{
                        databaseBytes: query.data.databaseBytes,
                        walBytes: query.data.walBytes,
                        shmBytes: query.data.shmBytes,
                    }}
                    totalBytes={query.data.totalBytes}
                    path={query.data.path}
                    labels={{
                        title: t('settings.storage.chartTitle'),
                        empty: t('settings.storage.chartEmpty'),
                        database: t('settings.storage.database'),
                        wal: t('settings.storage.wal'),
                        shm: t('settings.storage.shm'),
                        total: t('settings.storage.total'),
                        path: t('settings.storage.path'),
                    }}
                />
            ) : null}
            <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50"
            >
                {query.isFetching ? t('settings.storage.refreshing') : t('settings.storage.refresh')}
            </button>
        </SettingsPageContent>
    )
}
