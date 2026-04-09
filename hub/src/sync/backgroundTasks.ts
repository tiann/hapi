import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

/**
 * Extract background task start/completion signals from a message.
 *
 * Uses role-aware parsing to avoid false positives from user text:
 *  - Started:   agent-role output with tool_result containing
 *               "Command running in background with ID:"
 *  - Completed: user-role sidechain message starting with "<task-notification>"
 */
export function extractBackgroundTaskDelta(messageContent: unknown): { started: number; completed: number } | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    const started = record.role === 'agent' ? countTaskStarts(record.content) : 0
    const completed = record.role === 'user' ? countTaskCompletions(record.content) : 0

    if (started === 0 && completed === 0) return null
    return { started, completed }
}

/**
 * Count background task starts from agent output messages.
 * Looks for tool_result blocks containing the sentinel text.
 */
function countTaskStarts(content: unknown): number {
    if (!isObject(content) || content.type !== 'output') return 0

    const data = isObject(content.data) ? content.data : null
    if (!data) return 0

    // tool_result in user turn (Claude API format wrapped as output)
    if (data.type === 'tool_result') {
        return isBackgroundStartResult(data) ? 1 : 0
    }

    // assistant message with content array containing tool_result blocks
    const message = isObject(data.message) ? data.message : null
    const modelContent = message?.content
    if (!Array.isArray(modelContent)) return 0

    let count = 0
    for (const block of modelContent) {
        if (isObject(block) && block.type === 'tool_result' && isBackgroundStartResult(block)) {
            count++
        }
    }
    return count
}

function isBackgroundStartResult(block: Record<string, unknown>): boolean {
    const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
            ? block.content.map((c: unknown) => isObject(c) && typeof c.text === 'string' ? c.text : '').join('')
            : ''
    return text.includes('Command running in background with ID:')
}

/**
 * Count task completions from user-role messages.
 * Only matches messages that start with <task-notification> (system-injected),
 * not user text that happens to mention the tag.
 */
function countTaskCompletions(content: unknown): number {
    // String content: direct user message (system-injected task notifications)
    if (typeof content === 'string') {
        return content.trimStart().startsWith('<task-notification>') ? 1 : 0
    }

    // Object with text field
    if (isObject(content) && typeof content.text === 'string') {
        return content.text.trimStart().startsWith('<task-notification>') ? 1 : 0
    }

    // Object with message.content string (nested format)
    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return content.text.trimStart().startsWith('<task-notification>') ? 1 : 0
    }

    if (isObject(content) && isObject(content.message)) {
        const msg = content.message as Record<string, unknown>
        if (typeof msg.content === 'string') {
            return msg.content.trimStart().startsWith('<task-notification>') ? 1 : 0
        }
    }

    return 0
}
