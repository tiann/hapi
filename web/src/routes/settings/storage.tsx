import { useQuery } from '@tanstack/react-query'
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
            <SettingsSection>
                {query.isLoading ? <SettingsRow label={t('settings.storage.loading')} /> : null}
                {query.error ? <SettingsRow label={t('settings.storage.error')} description={query.error instanceof Error ? query.error.message : undefined} /> : null}
                {query.data ? (
                    <>
                        <SettingsRow label={t('settings.storage.total')} trailing={<span className="font-medium text-[var(--app-fg)]">{formatFileSize(query.data.totalBytes)}</span>} />
                        <SettingsRow label={t('settings.storage.database')} trailing={<span className="text-[var(--app-hint)]">{formatFileSize(query.data.databaseBytes)}</span>} />
                        <SettingsRow label={t('settings.storage.wal')} trailing={<span className="text-[var(--app-hint)]">{formatFileSize(query.data.walBytes)}</span>} />
                        <SettingsRow label={t('settings.storage.shm')} trailing={<span className="text-[var(--app-hint)]">{formatFileSize(query.data.shmBytes)}</span>} />
                        <SettingsRow label={t('settings.storage.path')} trailing={
                            <code className="block max-w-[min(20rem,55vw)] truncate text-xs text-[var(--app-hint)]" title={query.data.path}>
                                {query.data.path}
                            </code>
                        } />
                    </>
                ) : null}
            </SettingsSection>
            <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="rounded-lg bg-[var(--app-link)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
                {query.isFetching ? t('settings.storage.refreshing') : t('settings.storage.refresh')}
            </button>
        </SettingsPageContent>
    )
}
