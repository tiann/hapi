import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { renderTemplate } from '@/lib/template'
import { useTranslation } from '@/lib/use-translation'
import type { CopyTemplate, NotificationCopyConfig, NotificationPreferencesUpdate } from '@/types/api'

type ToggleKey = keyof NotificationPreferencesUpdate
type CopyKey = keyof NotificationCopyConfig

const COPY_BLOCKS: Array<{ key: CopyKey; labelKey: string; variables: string[] }> = [
    { key: 'permissionRequest', labelKey: 'settings.notifications.copy.permissionRequest', variables: ['agentName', 'sessionName', 'tool', 'url'] },
    { key: 'ready', labelKey: 'settings.notifications.copy.ready', variables: ['agentName', 'sessionName', 'url'] },
    { key: 'taskCompleted', labelKey: 'settings.notifications.copy.taskCompleted', variables: ['agentName', 'sessionName', 'summary', 'status', 'url'] },
    { key: 'taskFailed', labelKey: 'settings.notifications.copy.taskFailed', variables: ['agentName', 'sessionName', 'summary', 'status', 'url'] },
    { key: 'sessionCompletion', labelKey: 'settings.notifications.copy.sessionCompletion', variables: ['agentName', 'sessionName', 'reason', 'url'] },
]

// Sample values used for the live preview only.
const PREVIEW_VARS: Record<string, string> = {
    agentName: 'Claude',
    sessionName: 'My Project',
    tool: ' (Bash)',
    summary: 'Build the feature',
    status: 'completed',
    reason: 'completed',
    url: '/sessions/abc123',
}

function getNamespace(token: string): string | null {
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

type FocusTarget = {
    block: CopyKey
    field: 'title' | 'body'
    el: HTMLInputElement | HTMLTextAreaElement
}

export default function SettingsNotificationsPage() {
    const { api, token } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [confirmDisablePermission, setConfirmDisablePermission] = useState(false)
    const [testPushLabel, setTestPushLabel] = useState<string | null>(null)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [copySaved, setCopySaved] = useState(false)
    const focusedRef = useRef<FocusTarget | null>(null)

    const isAdmin = Boolean(token) && getNamespace(token) === 'default'

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

    const copyQuery = useQuery({
        queryKey: queryKeys.notificationCopy,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getNotificationCopy()
        },
        enabled: Boolean(api) && isAdmin,
        staleTime: 0,
        retry: false,
    })

    const [draft, setDraft] = useState<NotificationCopyConfig>({})
    const userEditedRef = useRef(false)
    useEffect(() => {
        // Initialize the draft from server copy, but never clobber edits made
        // while the query was still resolving.
        if (copyQuery.data && !userEditedRef.current) {
            setDraft(copyQuery.data.copy)
        }
    }, [copyQuery.data])

    const copyMutation = useMutation({
        mutationFn: async (copy: NotificationCopyConfig) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateNotificationCopy(copy)
        },
        onSuccess: (data) => {
            queryClient.setQueryData(queryKeys.notificationCopy, data)
            setDraft(data.copy)
            setCopySaved(true)
            setTimeout(() => setCopySaved(false), 3000)
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

    const updateDraftField = (block: CopyKey, field: 'title' | 'body', value: string) => {
        userEditedRef.current = true
        setDraft((prev) => {
            const current = prev[block] ?? { title: '', body: '' }
            return { ...prev, [block]: { ...current, [field]: value } }
        })
    }

    const insertVariable = (block: CopyKey, varName: string) => {
        userEditedRef.current = true
        const focused = focusedRef.current
        const target = focused && focused.block === block ? focused : null
        const field = target?.field ?? 'body'
        setDraft((prev) => {
            const current = prev[block] ?? { title: '', body: '' }
            const value = current[field]
            let next = `${value}{${varName}}`
            if (target) {
                const start = target.el.selectionStart ?? value.length
                const end = target.el.selectionEnd ?? value.length
                next = value.slice(0, start) + `{${varName}}` + value.slice(end)
            }
            return { ...prev, [block]: { ...current, [field]: next } }
        })
        // Keep focus in the field after the re-render.
        requestAnimationFrame(() => {
            target?.el.focus()
        })
    }

    const resolvePreview = (block: CopyKey): { title: string; body: string } => {
        const d = draft[block]
        const defaults = copyQuery.data?.defaults
        const def = defaults ? defaults[block] as CopyTemplate | undefined : undefined
        if (d && d.title.trim() && d.body.trim()) {
            return { title: renderTemplate(d.title, PREVIEW_VARS), body: renderTemplate(d.body, PREVIEW_VARS) }
        }
        return {
            title: renderTemplate(def?.title ?? '', PREVIEW_VARS),
            body: renderTemplate(def?.body ?? '', PREVIEW_VARS)
        }
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

            {isAdmin ? (
                <SettingsSection
                    title={t('settings.notifications.copy.title')}
                    description={t('settings.notifications.copy.description')}
                >
                    {COPY_BLOCKS.map((block) => {
                        const current = draft[block.key] ?? { title: '', body: '' }
                        const preview = resolvePreview(block.key)
                        return (
                            <div key={block.key} className="px-3 py-3 space-y-2">
                                <div className="text-sm font-medium text-[var(--app-fg)]">{t(block.labelKey)}</div>
                                <div className="flex flex-wrap gap-1">
                                    {block.variables.map((variable) => (
                                        <button
                                            key={variable}
                                            type="button"
                                            onClick={() => insertVariable(block.key, variable)}
                                            className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-xs text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                                        >
                                            {'{'}
                                            {variable}
                                            {'}'}
                                        </button>
                                    ))}
                                </div>
                                <label className="block">
                                    <span className="text-xs text-[var(--app-hint)]">{t('settings.notifications.copy.titleLabel')}</span>
                                    <input
                                        type="text"
                                        value={current.title}
                                        maxLength={500}
                                        onChange={(event) => updateDraftField(block.key, 'title', event.target.value)}
                                        onFocus={(event) => { focusedRef.current = { block: block.key, field: 'title', el: event.currentTarget } }}
                                        onBlur={() => { if (focusedRef.current?.block === block.key && focusedRef.current.field === 'title') focusedRef.current = null }}
                                        className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                                    />
                                </label>
                                <label className="block">
                                    <span className="text-xs text-[var(--app-hint)]">{t('settings.notifications.copy.bodyLabel')}</span>
                                    <textarea
                                        value={current.body}
                                        maxLength={500}
                                        rows={2}
                                        onChange={(event) => updateDraftField(block.key, 'body', event.target.value)}
                                        onFocus={(event) => { focusedRef.current = { block: block.key, field: 'body', el: event.currentTarget } }}
                                        onBlur={() => { if (focusedRef.current?.block === block.key && focusedRef.current.field === 'body') focusedRef.current = null }}
                                        className="mt-1 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                                    />
                                </label>
                                <div className="text-xs text-[var(--app-hint)]">
                                    {t('settings.notifications.copy.preview')}: {preview.title} — {preview.body}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        updateDraftField(block.key, 'title', '')
                                        updateDraftField(block.key, 'body', '')
                                    }}
                                    className="text-xs text-[var(--app-link)] hover:underline"
                                >
                                    {t('settings.notifications.copy.resetDefault')}
                                </button>
                            </div>
                        )
                    })}
                    <SettingsRow
                        label={copySaved ? t('settings.notifications.copy.saved') : t('settings.notifications.copy.testPushNote')}
                        trailing={(
                            <button
                                type="button"
                                onClick={() => copyMutation.mutate(draft)}
                                disabled={copyMutation.isPending}
                                className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50"
                            >
                                {t('settings.notifications.copy.save')}
                            </button>
                        )}
                    />
                </SettingsSection>
            ) : null}

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
