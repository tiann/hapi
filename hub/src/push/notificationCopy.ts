import type { SessionEndReason } from '@hapi/protocol'
import { z } from 'zod'
import { getSettingsFile, readSettings } from '../config/settings'
import type { TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { Session } from '../sync/syncEngine'

export type CopyKey = 'permissionRequest' | 'ready' | 'taskCompleted' | 'taskFailed' | 'sessionCompletion'

const copyTemplateSchema = z.object({
    title: z.string().max(500),
    body: z.string().max(500)
})

const MAX_RENDERED_TITLE_JSON_BYTES = 512
const MAX_RENDERED_BODY_JSON_BYTES = 2_500

export const notificationCopySchema = z.object({
    permissionRequest: copyTemplateSchema.optional(),
    ready: copyTemplateSchema.optional(),
    taskCompleted: copyTemplateSchema.optional(),
    taskFailed: copyTemplateSchema.optional(),
    sessionCompletion: copyTemplateSchema.optional()
})

export type CopyTemplate = z.infer<typeof copyTemplateSchema>
export type NotificationCopyConfig = z.infer<typeof notificationCopySchema>

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
        const parsed = notificationCopySchema.safeParse(settings?.notificationCopy ?? {})
        return parsed.success ? parsed.data : {}
    } catch {
        return {}
    }
}

/**
 * Empty fields fall back independently so a title-only or body-only override
 * still takes effect.
 */
export function resolveCopy(key: CopyKey, stored: NotificationCopyConfig): CopyTemplate {
    const template = stored[key]
    const defaults = DEFAULT_COPY[key]
    return {
        title: template?.title.trim() ? template.title : defaults.title,
        body: template?.body.trim() ? template.body : defaults.body
    }
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

export function truncateJsonString(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return ''
    let bytes = 0
    let result = ''
    for (const char of value) {
        const charBytes = Buffer.byteLength(JSON.stringify(char), 'utf8') - 2
        if (bytes + charBytes > maxBytes) break
        bytes += charBytes
        result += char
    }
    return result
}

export type NotificationCopyResult = {
    title: string
    body: string
}

function render(template: CopyTemplate, vars: Record<string, string>): NotificationCopyResult {
    const title = renderTemplate(template.title, vars)
    const body = renderTemplate(template.body, vars)
    return {
        title: truncateJsonString(title, MAX_RENDERED_TITLE_JSON_BYTES),
        body: truncateJsonString(body, MAX_RENDERED_BODY_JSON_BYTES)
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
