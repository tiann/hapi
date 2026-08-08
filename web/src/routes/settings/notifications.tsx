import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ChevronDownIcon, SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { renderTemplate } from '@/lib/template'
import { useTranslation } from '@/lib/use-translation'
import type { CopyTemplate, NotificationCopyConfig, NotificationPreferencesUpdate } from '@/types/api'

type ToggleKey = keyof NotificationPreferencesUpdate
type CopyKey = keyof NotificationCopyConfig

const COPY_BLOCKS: Array<{ key: CopyKey; labelKey: string }> = [
    { key: 'permissionRequest', labelKey: 'settings.notifications.copy.permissionRequest' },
    { key: 'ready', labelKey: 'settings.notifications.copy.ready' },
    { key: 'taskCompleted', labelKey: 'settings.notifications.copy.taskCompleted' },
    { key: 'taskFailed', labelKey: 'settings.notifications.copy.taskFailed' },
    { key: 'sessionCompletion', labelKey: 'settings.notifications.copy.sessionCompletion' },
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

function resolveCopyTemplate(
    copy: NotificationCopyConfig,
    defaults: Record<string, CopyTemplate>,
    key: CopyKey
): CopyTemplate {
    const template = copy[key]
    const fallback = defaults[key]
    return {
        title: template?.title.trim() ? template.title : (fallback?.title ?? ''),
        body: template?.body.trim() ? template.body : (fallback?.body ?? '')
    }
}

function resolveEffectiveCopy(
    copy: NotificationCopyConfig,
    defaults: Record<string, CopyTemplate>
): NotificationCopyConfig {
    return Object.fromEntries(
        COPY_BLOCKS.map(({ key }) => [key, resolveCopyTemplate(copy, defaults, key)])
    ) as NotificationCopyConfig
}

function getCopyOverrides(
    draft: NotificationCopyConfig,
    defaults: Record<string, CopyTemplate>
): NotificationCopyConfig {
    const overrides: NotificationCopyConfig = {}
    for (const { key } of COPY_BLOCKS) {
        const template = resolveCopyTemplate(draft, defaults, key)
        const fallback = defaults[key]
        if (!fallback || template.title !== fallback.title || template.body !== fallback.body) {
            overrides[key] = template
        }
    }
    return overrides
}

export default function SettingsNotificationsPage() {
    const { api, token } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [confirmDisablePermission, setConfirmDisablePermission] = useState(false)
    const [testPushLabel, setTestPushLabel] = useState<string | null>(null)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [copySaved, setCopySaved] = useState(false)
    const [copySaveError, setCopySaveError] = useState<string | null>(null)
    const [openCopyBlock, setOpenCopyBlock] = useState<CopyKey | null>(null)

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
        scope: { id: 'notification-preferences' },
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
    const editRevisionRef = useRef(0)
    useEffect(() => {
        // Initialize the draft from server copy, but never clobber edits made
        // while the query was still resolving.
        if (copyQuery.data && !userEditedRef.current) {
            setDraft(resolveEffectiveCopy(copyQuery.data.copy, copyQuery.data.defaults))
        }
    }, [copyQuery.data])

    const copyMutation = useMutation({
        mutationFn: async (copy: NotificationCopyConfig) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateNotificationCopy(copy)
        },
        onMutate: () => {
            setCopySaveError(null)
            return { editRevision: editRevisionRef.current }
        },
        onSuccess: (data, _copy, context) => {
            queryClient.setQueryData(queryKeys.notificationCopy, data)
            if (context?.editRevision === editRevisionRef.current) {
                userEditedRef.current = false
                setDraft(resolveEffectiveCopy(data.copy, data.defaults))
            }
            setCopySaveError(null)
            setCopySaved(true)
            setTimeout(() => setCopySaved(false), 3000)
        },
        onError: () => {
            setCopySaved(false)
            setCopySaveError(t('settings.notifications.copy.saveError'))
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
        editRevisionRef.current += 1
        setDraft((prev) => {
            const current = prev[block] ?? { title: '', body: '' }
            return { ...prev, [block]: { ...current, [field]: value } }
        })
    }

    const resetDraftBlock = (block: CopyKey) => {
        userEditedRef.current = true
        editRevisionRef.current += 1
        setDraft((prev) => {
            const fallback = copyQuery.data?.defaults[block]
            return fallback ? { ...prev, [block]: fallback } : prev
        })
    }

    const resolvePreview = (block: CopyKey): { title: string; body: string } => {
        const d = draft[block]
        const defaults = copyQuery.data?.defaults
        const def = defaults ? defaults[block] as CopyTemplate | undefined : undefined
        return {
            title: renderTemplate(d?.title.trim() ? d.title : (def?.title ?? ''), PREVIEW_VARS),
            body: renderTemplate(d?.body.trim() ? d.body : (def?.body ?? ''), PREVIEW_VARS)
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

            {isAdmin && copyQuery.data ? (
                <SettingsSection
                    title={t('settings.notifications.copy.title')}
                    description={t('settings.notifications.copy.description')}
                >
                    {COPY_BLOCKS.map((block) => {
                        const current = resolveCopyTemplate(draft, copyQuery.data?.defaults ?? {}, block.key)
                        const preview = resolvePreview(block.key)
                        const isOpen = openCopyBlock === block.key
                        const editorId = `notification-copy-${block.key}`
                        return (
                            <div key={block.key}>
                                <button
                                    type="button"
                                    onClick={() => setOpenCopyBlock((currentBlock) => currentBlock === block.key ? null : block.key)}
                                    aria-expanded={isOpen}
                                    aria-controls={editorId}
                                    className="flex min-h-14 w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-[var(--app-fg)]">{t(block.labelKey)}</span>
                                        <span className="mt-0.5 block truncate text-xs text-[var(--app-hint)]">
                                            {preview.title} · {preview.body}
                                        </span>
                                    </span>
                                    <ChevronDownIcon className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                </button>
                                {isOpen ? (
                                    <div id={editorId} className="space-y-3 border-t border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 px-3 py-3">
                                        <label className="block">
                                            <span className="text-xs text-[var(--app-hint)]">{t('settings.notifications.copy.titleLabel')}</span>
                                            <input
                                                type="text"
                                                value={current.title}
                                                maxLength={500}
                                                onChange={(event) => updateDraftField(block.key, 'title', event.target.value)}
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
                                                className="mt-1 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                                            />
                                        </label>
                                        <div className="flex justify-end">
                                            <button
                                                type="button"
                                                onClick={() => resetDraftBlock(block.key)}
                                                className="text-xs text-[var(--app-link)] hover:underline"
                                            >
                                                {t('settings.notifications.copy.resetDefault')}
                                            </button>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}
                    <div className="flex min-h-14 items-center justify-between gap-3 px-3 py-3">
                        <span className="text-xs text-[var(--app-hint)]" aria-live="polite">
                            {copySaveError ?? (copySaved ? t('settings.notifications.copy.saved') : '')}
                        </span>
                        <button
                            type="button"
                            onClick={() => copyMutation.mutate(getCopyOverrides(draft, copyQuery.data?.defaults ?? {}))}
                            disabled={copyMutation.isPending || !copyQuery.data}
                            className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50"
                        >
                            {t('settings.notifications.copy.save')}
                        </button>
                    </div>
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
                    await mutation.mutateAsync({ permissionRequests: 0 })
                }}
                isPending={mutation.isPending}
                destructive
            />
        </SettingsPageContent>
    )
}
