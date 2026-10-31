import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { BackgroundTask } from '@hapi/protocol/types'

/**
 * Read the running background tasks from Claude's
 * `system/background_tasks_changed` snapshot.
 *
 * Claude Code (SDK mode) emits it whenever the set of background tasks
 * changes, including an empty `tasks` list once the last one finishes. The
 * CLI forwards it as { role: 'agent', content: { type: 'output', data } }.
 * Being a full snapshot, it replaces the list instead of adjusting it.
 */
export function extractBackgroundTasks(messageContent: unknown): BackgroundTask[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record || record.role !== 'agent') return null
    if (!isObject(record.content) || record.content.type !== 'output') return null

    const data = isObject(record.content.data) ? record.content.data : null
    if (data?.type !== 'system' || data.subtype !== 'background_tasks_changed') return null
    if (!Array.isArray(data.tasks)) return null

    return data.tasks.filter(isObject).map((task) => ({
        id: typeof task.task_id === 'string' ? task.task_id : '',
        type: typeof task.task_type === 'string' ? task.task_type : '',
        description: typeof task.description === 'string' ? task.description : ''
    }))
}
