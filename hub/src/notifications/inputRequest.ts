import { isObject, type AgentStateRequest } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { getAgentName, getSessionName } from './sessionInfo'

const INPUT_REQUEST_TOOLS = new Set([
    'request_user_input',
    'AskUserQuestion',
    'ask_user_question',
    'CursorAskQuestion'
])

const BODY_LIMIT = 280
const SESSION_NAME_LIMIT = 80
const FALLBACK_QUESTION = 'Open the session to view and answer the question.'
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export type PendingNotificationRequest = { requestId: string; request: AgentStateRequest }

/** Keep the existing first-pending selection; text and actions must use the same request. */
export function getFirstPendingRequest(session: Session): PendingNotificationRequest | null {
    const entry = Object.entries(session.agentState?.requests ?? {})[0]
    return entry ? { requestId: entry[0], request: entry[1] } : null
}

export function isInputRequestTool(tool: string): boolean {
    // Only the known functions wrapper is stripped, never arbitrary MCP prefixes/suffixes.
    const name = tool.startsWith('functions.') ? tool.slice('functions.'.length) : tool
    return INPUT_REQUEST_TOOLS.has(name)
}

function oneLine(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/** Budget in Unicode code points, cutting only at grapheme boundaries (including emoji). */
function truncate(text: string, limit: number): string {
    if (limit <= 0) return ''
    if (Array.from(text).length <= limit) return text
    let result = ''
    let length = 0
    for (const { segment } of graphemes.segment(text)) {
        const size = Array.from(segment).length
        if (length + size > limit - 1) break
        result += segment
        length += size
    }
    return `${result.trimEnd()}…`
}

/** Extract display text only. IDs, options, descriptions, prefill and answers are never previews. */
export function formatInputRequestPreview(args: unknown, limit: number = BODY_LIMIT): string {
    const questions = isObject(args) && Array.isArray(args.questions)
        ? args.questions.flatMap((question) => {
            if (!isObject(question)) return []
            const text = oneLine(question.question) || oneLine(question.header)
            return text ? [text] : []
        })
        : []
    const remaining = questions.length - 1
    const suffix = remaining > 0 ? `\n+${remaining} more question${remaining === 1 ? '' : 's'}` : ''
    const first = truncate(questions[0] ?? FALLBACK_QUESTION, Math.max(0, limit - suffix.length))
    return truncate(`${first}${suffix}`, limit)
}

export function composeInputRequestNotification(
    session: Session,
    pending: PendingNotificationRequest | null = getFirstPendingRequest(session)
) {
    if (!pending || !isInputRequestTool(pending.request.tool)) return null

    const sessionName = truncate(oneLine(getSessionName(session)), SESSION_NAME_LIMIT)
    const context = sessionName ? `\n${sessionName}` : ''
    const preview = formatInputRequestPreview(pending.request.arguments, BODY_LIMIT - Array.from(context).length)
    return {
        type: 'input-request' as const,
        title: `${getAgentName(session)} needs your input`,
        body: `${preview}${context}`,
        tag: `input-request-${session.id}`,
        sessionId: session.id,
        sessionName,
        url: `/sessions/${session.id}`,
        // Correlation only: this type never offers approve/deny or ordinary message Reply.
        requestId: pending.requestId,
        severity: 'info' as const
    }
}
