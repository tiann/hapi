import type { SessionEndReason } from '@hapi/protocol'
import { getSettingsFile, readSettings } from '../config/settings'
import type { TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { Session } from '../sync/syncEngine'

export type CopyKey = 'permissionRequest' | 'ready' | 'taskCompleted' | 'taskFailed' | 'sessionCompletion'

export type CopyTemplate = {
    title: string
    body: string
}

export type NotificationCopyConfig = Partial<Record<CopyKey, CopyTemplate>>

export const COPY_KEYS: readonly CopyKey[] = [
    'permissionRequest',
    'ready',
    'taskCompleted',
    'taskFailed',
    'sessionCompletion'
] as const

/**
 * Default copy mirrors the pre-customization hardcoded strings exactly, so a
 * hub with no `notificationCopy` in settings.json behaves identically.
 */
export const DEFAULT_COPY: Record<CopyKey, CopyTemplate> = {
    permissionRequest: { title: 'Permission Request', body: '{sessionName}{tool}' },
    ready: { title: 'Ready for input', body: '{agentName} is waiting in {sessionName}' },
    taskCompleted: { title: 'Task completed', body: '{agentName} · {sessionName} · {summary}' },
    taskFailed: { title: 'Task failed', body: '{agentName} · {sessionName} · {summary}' },
    sessionCompletion: { title: 'Session completed', body: '{agentName} · {sessionName}' }
}

export async function loadNotificationCopy(dataDir: string): Promise<NotificationCopyConfig> {
    try {
        const settings = await readSettings(getSettingsFile(dataDir))
        return settings?.notificationCopy ?? {}
    } catch {
        return {}
    }
}

/**
 * A stored template only takes effect when BOTH title and body are non-empty;
 * an empty field falls back to the default template.
 */
export function resolveCopy(key: CopyKey, stored: NotificationCopyConfig): CopyTemplate {
    const template = stored[key]
    if (template && template.title.trim() && template.body.trim()) {
        return { title: template.title, body: template.body }
    }
    return DEFAULT_COPY[key]
}

/**
 * Replaces `{var}` placeholders. Unknown placeholders are left as-is so a
 * typo stays visible in the delivered notification instead of vanishing.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
        return key in vars ? vars[key] : match
    })
}

export type NotificationCopyResult = {
    title: string
    body: string
}

function render(template: CopyTemplate, vars: Record<string, string>): NotificationCopyResult {
    return {
        title: renderTemplate(template.title, vars),
        body: renderTemplate(template.body, vars)
    }
}

/**
 * `{tool}` resolves to ` (ToolName)` (leading space + parens) or the empty
 * string — matching the pre-customization body format.
 */
export function buildPermissionRequestCopy(
    session: Session,
    stored: NotificationCopyConfig,
    url: string
): NotificationCopyResult {
    const request = Object.entries(session.agentState?.requests ?? {})[0]?.[1] ?? null
    const tool = request?.tool ? ` (${request.tool})` : ''
    return render(resolveCopy('permissionRequest', stored), {
        agentName: getAgentName(session),
        sessionName: getSessionName(session),
        tool,
        url
    })
}

export function buildReadyCopy(
    session: Session,
    stored: NotificationCopyConfig,
    url: string
): NotificationCopyResult {
    return render(resolveCopy('ready', stored), {
        agentName: getAgentName(session),
        sessionName: getSessionName(session),
        url
    })
}

export function isTaskFailure(status: string | undefined): boolean {
    const normalized = status?.trim().toLowerCase()
    return normalized === 'failed'
        || normalized === 'error'
        || normalized === 'killed'
        || normalized === 'aborted'
}

export function buildTaskCopy(
    session: Session,
    notification: TaskNotification,
    stored: NotificationCopyConfig,
    url: string
): NotificationCopyResult & { isFailure: boolean } {
    const isFailure = isTaskFailure(notification.status)
    const key: CopyKey = isFailure ? 'taskFailed' : 'taskCompleted'
    const rendered = render(resolveCopy(key, stored), {
        agentName: getAgentName(session),
        sessionName: getSessionName(session),
        summary: notification.summary,
        status: notification.status ?? '',
        url
    })
    return { ...rendered, isFailure }
}

export function buildSessionCompletionCopy(
    session: Session,
    reason: SessionEndReason,
    stored: NotificationCopyConfig,
    url: string
): NotificationCopyResult {
    return render(resolveCopy('sessionCompletion', stored), {
        agentName: getAgentName(session),
        sessionName: getSessionName(session),
        reason,
        url
    })
}
