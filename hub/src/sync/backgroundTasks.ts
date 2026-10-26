import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

/**
 * Read the running background task count from Claude's
 * `system/background_tasks_changed` snapshot.
 *
 * Claude Code (SDK mode) emits it whenever the set of background tasks
 * changes, including an empty `tasks` list once the last one finishes. The
 * CLI forwards it as { role: 'agent', content: { type: 'output', data } }.
 * Being a full snapshot, it replaces the count instead of adjusting it.
 */
export function extractBackgroundTaskCount(messageContent: unknown): number | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'agent') return null
    if (!isObject(record.content) || record.content.type !== 'output') return null

    const data = isObject(record.content.data) ? record.content.data : null
    if (data?.type !== 'system' || data.subtype !== 'background_tasks_changed') return null

    return Array.isArray(data.tasks) ? data.tasks.length : null
}
