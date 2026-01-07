import { useState, useCallback, useEffect } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ApiClient } from '@/api/client'
import { usePushNotifications } from '@/hooks/usePushNotifications'

type NotificationSettingsProps = {
    isOpen: boolean
    onClose: () => void
    api: ApiClient | null
}

// Local storage keys for notification preferences
const STORAGE_KEYS = {
    permissions: 'hapi:notify:permissions',
    questions: 'hapi:notify:questions',
    ready: 'hapi:notify:ready',
    errors: 'hapi:notify:errors'
} as const

// Cache storage for service worker access
const PREFERENCES_CACHE_NAME = 'notification-preferences'
const PREFERENCES_KEY = 'preferences.json'

type NotificationPreferences = {
    permissions: boolean
    questions: boolean
    ready: boolean
    errors: boolean
}

function getStoredPreference(key: string): boolean {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(key)
    return stored === null ? true : stored === 'true'
}

function setStoredPreference(key: string, value: boolean): void {
    localStorage.setItem(key, String(value))
}

async function syncPreferencesToCache(): Promise<void> {
    if (typeof window === 'undefined' || !('caches' in window)) return

    const prefs: NotificationPreferences = {
        permissions: getStoredPreference(STORAGE_KEYS.permissions),
        questions: getStoredPreference(STORAGE_KEYS.questions),
        ready: getStoredPreference(STORAGE_KEYS.ready),
        errors: getStoredPreference(STORAGE_KEYS.errors)
    }

    try {
        const cache = await caches.open(PREFERENCES_CACHE_NAME)
        const response = new Response(JSON.stringify(prefs), {
            headers: { 'Content-Type': 'application/json' }
        })
        await cache.put(PREFERENCES_KEY, response)
    } catch (error) {
        console.error('[NotificationSettings] Failed to sync preferences to cache:', error)
    }
}

function BellIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
    )
}

function Toggle(props: {
    checked: boolean
    onChange: (checked: boolean) => void
    disabled?: boolean
    label: string
    description?: string
}) {
    const { checked, onChange, disabled, label, description } = props

    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`flex items-start gap-3 p-3 w-full text-left rounded-lg transition-colors ${
                disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-[var(--app-bg-hover)]'
            }`}
        >
            <div
                className={`relative flex-shrink-0 h-6 w-11 rounded-full transition-colors ${
                    checked ? 'bg-[var(--app-button)]' : 'bg-[var(--app-border)]'
                }`}
            >
                <div
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                        checked ? 'translate-x-5' : 'translate-x-0'
                    }`}
                />
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--app-fg)]">{label}</div>
                {description && (
                    <div className="text-xs text-[var(--app-hint)] mt-0.5">{description}</div>
                )}
            </div>
        </button>
    )
}

export function NotificationSettings(props: NotificationSettingsProps) {
    const { isOpen, onClose, api } = props
    const { isSupported, permission, isSubscribed, requestPermission, subscribe, unsubscribe } = usePushNotifications(api)

    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Per-type notification preferences
    const [permissionsEnabled, setPermissionsEnabled] = useState(() => getStoredPreference(STORAGE_KEYS.permissions))
    const [questionsEnabled, setQuestionsEnabled] = useState(() => getStoredPreference(STORAGE_KEYS.questions))
    const [readyEnabled, setReadyEnabled] = useState(() => getStoredPreference(STORAGE_KEYS.ready))
    const [errorsEnabled, setErrorsEnabled] = useState(() => getStoredPreference(STORAGE_KEYS.errors))

    // Sync preferences to cache on mount
    useEffect(() => {
        void syncPreferencesToCache()
    }, [])

    const handleEnableNotifications = useCallback(async () => {
        setIsLoading(true)
        setError(null)

        try {
            const permissionGranted = await requestPermission()
            if (!permissionGranted) {
                setError('Notification permission was denied. Please enable notifications in your browser settings.')
                return
            }

            const subscribed = await subscribe()
            if (!subscribed) {
                setError('Failed to subscribe to push notifications. Please try again.')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
        } finally {
            setIsLoading(false)
        }
    }, [requestPermission, subscribe])

    const handleDisableNotifications = useCallback(async () => {
        setIsLoading(true)
        setError(null)

        try {
            const success = await unsubscribe()
            if (!success) {
                setError('Failed to unsubscribe from push notifications.')
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unexpected error occurred.')
        } finally {
            setIsLoading(false)
        }
    }, [unsubscribe])

    const handleTogglePreference = useCallback((key: keyof typeof STORAGE_KEYS, value: boolean) => {
        setStoredPreference(STORAGE_KEYS[key], value)
        switch (key) {
            case 'permissions':
                setPermissionsEnabled(value)
                break
            case 'questions':
                setQuestionsEnabled(value)
                break
            case 'ready':
                setReadyEnabled(value)
                break
            case 'errors':
                setErrorsEnabled(value)
                break
        }
        // Sync to cache for service worker access
        void syncPreferencesToCache()
    }, [])

    const renderContent = () => {
        if (!isSupported) {
            // Debug info for iOS troubleshooting
            const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
            const hasPushManager = typeof window !== 'undefined' && 'PushManager' in window
            const hasNotification = typeof window !== 'undefined' && 'Notification' in window
            const isStandalone = typeof window !== 'undefined' && (
                window.matchMedia('(display-mode: standalone)').matches ||
                (window.navigator as Navigator & { standalone?: boolean }).standalone === true
            )
            const isSecureContext = typeof window !== 'undefined' && window.isSecureContext
            const protocol = typeof window !== 'undefined' ? window.location.protocol : 'unknown'

            // Parse iOS version from userAgent
            let iosVersion = 'N/A'
            if (typeof navigator !== 'undefined') {
                const match = navigator.userAgent.match(/OS (\d+)[_.](\d+)/)
                if (match) {
                    iosVersion = `${match[1]}.${match[2]}`
                }
            }

            return (
                <div className="py-6 text-center">
                    <div className="text-[var(--app-hint)] text-sm mb-3">
                        Push notifications are not supported on this device or browser.
                    </div>
                    <div className="text-xs text-[var(--app-hint)] opacity-70 space-y-1">
                        <div>ServiceWorker: {hasServiceWorker ? '✓' : '✗'}</div>
                        <div>PushManager: {hasPushManager ? '✓' : '✗'}</div>
                        <div>Notification: {hasNotification ? '✓' : '✗'}</div>
                        <div>Standalone PWA: {isStandalone ? '✓' : '✗'}</div>
                        <div>Secure Context: {isSecureContext ? '✓' : '✗'}</div>
                        <div>Protocol: {protocol}</div>
                        <div>iOS Version: {iosVersion}</div>
                        {!isSecureContext && (
                            <div className="mt-2 text-[var(--app-badge-warning-text)]">
                                ServiceWorker requires HTTPS. Current: {protocol}
                            </div>
                        )}
                        {isSecureContext && !hasPushManager && (
                            <div className="mt-2 text-[var(--app-badge-warning-text)]">
                                iOS requires 16.4+ for push notifications.
                            </div>
                        )}
                    </div>
                </div>
            )
        }

        if (permission === 'denied') {
            return (
                <div className="py-6 text-center">
                    <div className="text-[var(--app-badge-error-text)] text-sm mb-2">
                        Notifications are blocked
                    </div>
                    <div className="text-[var(--app-hint)] text-xs">
                        To enable notifications, update your browser or device settings.
                    </div>
                </div>
            )
        }

        if (!isSubscribed) {
            return (
                <div className="py-6 flex flex-col items-center gap-4">
                    <BellIcon className="h-12 w-12 text-[var(--app-hint)]" />
                    <div className="text-center">
                        <div className="text-sm font-medium text-[var(--app-fg)] mb-1">
                            Enable Push Notifications
                        </div>
                        <div className="text-xs text-[var(--app-hint)] max-w-[250px]">
                            Get notified when Claude needs your attention or finishes a task.
                        </div>
                    </div>
                    <Button
                        onClick={handleEnableNotifications}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Enabling...' : 'Enable Notifications'}
                    </Button>
                </div>
            )
        }

        return (
            <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--app-bg-hover)] rounded-lg">
                    <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-[var(--app-badge-success-text)]" />
                        <span className="text-sm text-[var(--app-fg)]">Notifications enabled</span>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleDisableNotifications}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Disabling...' : 'Disable'}
                    </Button>
                </div>

                <div className="border-t border-[var(--app-border)] pt-4">
                    <div className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide px-3 mb-2">
                        Notification Types
                    </div>
                    <div className="flex flex-col">
                        <Toggle
                            checked={permissionsEnabled}
                            onChange={(v) => handleTogglePreference('permissions', v)}
                            label="Permission Requests"
                            description="When Claude needs approval for an action"
                        />
                        <Toggle
                            checked={questionsEnabled}
                            onChange={(v) => handleTogglePreference('questions', v)}
                            label="Questions"
                            description="When Claude asks you a question"
                        />
                        <Toggle
                            checked={readyEnabled}
                            onChange={(v) => handleTogglePreference('ready', v)}
                            label="Ready for Input"
                            description="When Claude finishes and is waiting"
                        />
                        <Toggle
                            checked={errorsEnabled}
                            onChange={(v) => handleTogglePreference('errors', v)}
                            label="Errors"
                            description="When something goes wrong"
                        />
                    </div>
                </div>
            </div>
        )
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Notification Settings</DialogTitle>
                </DialogHeader>
                <div className="mt-4">
                    {renderContent()}
                    {error && (
                        <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}

export function NotificationSettingsButton(props: { onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
            title="Notification Settings"
        >
            <BellIcon className="h-5 w-5" />
        </button>
    )
}
