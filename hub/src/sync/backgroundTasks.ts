import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

/**
 * Extract background task start/completion signals from a message.
 *
 * Returns { started, completed } counts.
 *
 * Detection:
 *  - Started:   tool_result containing "Command running in background with ID:"
 *  - Completed: <task-notification> user messages (sidechain prompts)
 */
export function extractBackgroundTaskDelta(messageContent: unknown): { started: number; completed: number } | null {
    const str = stringify(messageContent)
    if (!str) return null

    let started = 0
    let completed = 0

    // Detect background task starts from Bash tool_result
    const startPattern = /Command running in background with ID:/g
    const startMatches = str.match(startPattern)
    if (startMatches) {
        started = startMatches.length
    }

    // Detect background task completions from <task-notification>
    const completionPattern = /<task-notification>/g
    const completionMatches = str.match(completionPattern)
    if (completionMatches) {
        completed = completionMatches.length
    }

    if (started === 0 && completed === 0) return null

    return { started, completed }
}

function stringify(content: unknown): string | null {
    if (typeof content === 'string') return content
    if (content === null || content === undefined) return null
    try {
        return JSON.stringify(content)
    } catch {
        return null
    }
}
