import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { SettingsSwitch } from './SettingsPrimitives'

export function PushNotificationsControl() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { isSupported, permission, isSubscribed, requestPermission, subscribe, unsubscribe } = usePushNotifications(api)
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState(false)

    const change = async (enabled: boolean) => {
        setBusy(true)
        setFailed(false)
        try {
            // requestPermission must run directly in the user's click handler.
            const ok = enabled
                ? (await requestPermission()) && await subscribe()
                : await unsubscribe()
            if (!ok) setFailed(true)
        } catch {
            setFailed(true)
        } finally {
            setBusy(false)
        }
    }

    const description = !isSupported ? t('settings.notifications.unsupported')
        : permission === 'denied' ? t('settings.notifications.denied')
            : failed ? t('settings.notifications.failed')
                : t('settings.notifications.description')
    return <SettingsSwitch
        label={t('settings.notifications.push')}
        description={description}
        checked={isSubscribed}
        disabled={!api || !isSupported || permission === 'denied' || busy}
        onChange={(enabled) => { void change(enabled) }}
    />
}
