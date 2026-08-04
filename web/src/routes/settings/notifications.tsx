import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import type { NotificationPreferencesUpdate } from '@/types/api'

type ToggleKey = keyof NotificationPreferencesUpdate

export default function SettingsNotificationsPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [confirmDisablePermission, setConfirmDisablePermission] = useState(false)
    const [testPushLabel, setTestPushLabel] = useState<string | null>(null)
    const [saveError, setSaveError] = useState<string | null>(null)

    const query = useQuery({
        queryKey: queryKeys.notificationPreferences,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getNotificationPreferences()
        },
        enabled: Boolean(api),
        staleTime: 0,
        retry: false,
    })

    const mutation = useMutation({
        mutationFn: async (update: NotificationPreferencesUpdate) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateNotificationPreferences(update)
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.notificationPreferences, data)
            setSaveError(null)
        },
        onError: () => {
            setSaveError(t('settings.notifications.saveError'))
        },
    })

    const handleToggle = (key: ToggleKey) => (checked: boolean) => {
        // Turning off permission requests needs explicit confirmation — it
        // disables phone-side approval, the core remote-control flow.
        if (key === 'permissionRequests' && !checked) {
            setConfirmDisablePermission(true)
            return
        }
        mutation.mutate({ [key]: checked ? 1 : 0 })
    }

    const sendTestPush = async () => {
        if (!api) return
        setTestPushLabel(t('settings.notifications.testPushSending'))
        try {
            const result = await api.sendTestPush()
            setTestPushLabel('ok' in result
                ? t('settings.notifications.testPushSent')
                : t('settings.notifications.testPushError'))
        } catch {
            setTestPushLabel(t('settings.notifications.testPushError'))
        }
        setTimeout(() => setTestPushLabel(null), 3000)
    }

    const prefs = query.data

    return (
        <SettingsPageContent description={t('settings.notifications.description')}>
            <SettingsSection title={t('settings.notifications.section')}>
                <SettingsSwitch
                    label={t('settings.notifications.permissionRequests')}
                    description={t('settings.notifications.permissionRequestsDescription')}
                    checked={prefs ? Boolean(prefs.permissionRequests) : true}
                    onChange={handleToggle('permissionRequests')}
                />
                <SettingsSwitch
                    label={t('settings.notifications.sessionReady')}
                    description={t('settings.notifications.sessionReadyDescription')}
                    checked={prefs ? Boolean(prefs.sessionReady) : true}
                    onChange={handleToggle('sessionReady')}
                />
                <SettingsSwitch
                    label={t('settings.notifications.taskNotifications')}
                    description={t('settings.notifications.taskNotificationsDescription')}
                    checked={prefs ? Boolean(prefs.taskNotifications) : true}
                    onChange={handleToggle('taskNotifications')}
                />
                <SettingsSwitch
                    label={t('settings.notifications.sessionCompletion')}
                    description={t('settings.notifications.sessionCompletionDescription')}
                    checked={prefs ? Boolean(prefs.sessionCompletion) : true}
                    onChange={handleToggle('sessionCompletion')}
                />
                {saveError ? <SettingsRow label={saveError} /> : null}
            </SettingsSection>
            <button
                type="button"
                onClick={() => void sendTestPush()}
                disabled={testPushLabel !== null || !Boolean(api)}
                className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50"
            >
                {testPushLabel ?? t('settings.notifications.testPush')}
            </button>
            <ConfirmDialog
                isOpen={confirmDisablePermission}
                onClose={() => setConfirmDisablePermission(false)}
                title={t('settings.notifications.disablePermissionTitle')}
                description={t('settings.notifications.disablePermissionDescription')}
                confirmLabel={t('settings.notifications.disablePermissionConfirm')}
                confirmingLabel={t('settings.notifications.disablePermissionConfirm')}
                onConfirm={async () => {
                    mutation.mutate({ permissionRequests: 0 })
                }}
                isPending={mutation.isPending}
                destructive
            />
        </SettingsPageContent>
    )
}
