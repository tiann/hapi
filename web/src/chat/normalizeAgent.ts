import type { AgentEvent, CodexReview, CodexReviewFinding, NormalizedAgentContent, NormalizedMessage, ToolResultPermission } from '@/chat/types'
import { inlineMediaSourceFromWire } from '@/chat/inlineMediaSource'
import { AGENT_MESSAGE_PAYLOAD_TYPE, asNumber, asString, isObject } from '@hapi/protocol'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import { parseAgentTimestampMs } from '@/chat/agentTimestamp'

function normalizeToolResultPermissions(value: unknown): ToolResultPermission | undefined {
    if (!isObject(value)) return undefined
    const date = asNumber(value.date)
    const result = value.result
    if (date === null) return undefined
    if (result !== 'approved' && result !== 'denied') return undefined

    const mode = asString(value.mode) ?? undefined
    const allowedTools = Array.isArray(value.allowedTools)
        ? value.allowedTools.filter((tool) => typeof tool === 'string')
        : undefined
    const decision = value.decision
    const normalizedDecision = decision === 'approved' || decision === 'approved_for_session' || decision === 'denied' || decision === 'abort'
        ? decision
        : undefined

    return {
        date,
        result,
        mode,
        allowedTools,
        decision: normalizedDecision
    }
}

function normalizeAgentEvent(value: unknown): AgentEvent | null {
    if (!isObject(value) || typeof value.type !== 'string') return null
    return value as AgentEvent
}

function normalizeThreadGoal(value: unknown) {
    if (!isObject(value)) return null
    const threadId = asString(value.threadId ?? value.thread_id)
    const objective = asString(value.objective)
    const status = asString(value.status)
    if (!threadId || !objective || !status) return null
    if (status !== 'active' && status !== 'paused' && status !== 'budgetLimited' && status !== 'complete') return null
    return {
        threadId,
        objective,
        status,
        tokenBudget: asNumber(value.tokenBudget ?? value.token_budget),
        tokensUsed: asNumber(value.tokensUsed ?? value.tokens_used) ?? 0,
        timeUsedSeconds: asNumber(value.timeUsedSeconds ?? value.time_used_seconds) ?? 0,
        createdAt: asNumber(value.createdAt ?? value.created_at) ?? 0,
        updatedAt: asNumber(value.updatedAt ?? value.updated_at) ?? 0
    }
}

function normalizeCodexTokenUsage(value: unknown, data?: Record<string, unknown>) {
    const info = isObject(value) ? value : null
    if (!info) return null
    const scope = data && isObject(data.scope) ? data.scope : null
    // Codex reports both:
    // - `total`: cumulative usage for the whole session (can be millions).
    // - `last`: current turn/request usage, which matches the live context bar.
    // Prefer `last`; falling back to `total` keeps older payloads working.
    const usageSource = isObject(info.last)
        ? info.last
        : isObject(info.lastTokenUsage)
            ? info.lastTokenUsage
            : isObject(info.last_token_usage)
                ? info.last_token_usage
                : isObject(info.total)
                    ? info.total
                    : isObject(info.totalTokenUsage)
                        ? info.totalTokenUsage
                        : isObject(info.total_token_usage)
                            ? info.total_token_usage
                            : info
    const inputTokens = asNumber(usageSource.inputTokens ?? usageSource.input_tokens)
    const outputTokens = asNumber(usageSource.outputTokens ?? usageSource.output_tokens)
    if (inputTokens === null || outputTokens === null) return null

    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        // Codex `inputTokens` already includes cached input tokens; expose cache
        // hits for display, but use `context_tokens` to avoid double-counting.
        cache_creation_input_tokens: undefined,
        cache_read_input_tokens: asNumber(
            usageSource.cachedInputTokens
            ?? usageSource.cached_input_tokens
            ?? usageSource.cacheReadInputTokens
            ?? usageSource.cache_read_input_tokens
        ) ?? undefined,
        context_tokens: asNumber(
            info.contextTokens
            ?? info.context_tokens
            ?? usageSource.contextTokens
            ?? usageSource.context_tokens
        ) ?? inputTokens,
        context_window: asNumber(info.modelContextWindow ?? info.model_context_window) ?? undefined,
        thread_id: asString(
            data?.thread_id
            ?? data?.threadId
            ?? scope?.thread_id
            ?? scope?.threadId
            ?? info.thread_id
            ?? info.threadId
        ) ?? undefined,
        scope_role: asString(data?.scope_role ?? data?.scopeRole ?? scope?.role) ?? undefined
    }
}

function normalizePlanStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
    const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]/g, '_') : ''
    if (raw === 'completed' || raw === 'complete' || raw === 'done') return 'completed'
    if (raw === 'in_progress' || raw === 'inprogress' || raw === 'active' || raw === 'running') return 'in_progress'
    return 'pending'
}

function normalizePlanEntries(value: unknown): Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> {
    const record = isObject(value) ? value : null
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(record?.plan)
            ? record.plan
            : Array.isArray(record?.items)
                ? record.items
                : Array.isArray(record?.steps)
                    ? record.steps
                    : []

    const plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> = []
    for (const entry of entries) {
        if (typeof entry === 'string') {
            plan.push({ step: entry, status: 'pending' })
            continue
        }
        if (!isObject(entry)) continue
        const step = asString(entry.step)
            ?? asString(entry.content)
            ?? asString(entry.text)
            ?? asString(entry.title)
            ?? asString(entry.description)
        if (!step) continue
        plan.push({
            step,
            status: normalizePlanStatus(entry.status ?? entry.state)
        })
    }
    return plan
}

function normalizeCodexReviewFinding(value: unknown): CodexReviewFinding | null {
    if (!isObject(value)) return null
    const title = asString(value.title)
    const body = asString(value.body)
    if (!title || !body) return null

    const codeLocation = isObject(value.code_location)
        ? value.code_location
        : isObject(value.codeLocation)
            ? value.codeLocation
            : null
    const lineRange = codeLocation && isObject(codeLocation.line_range)
        ? codeLocation.line_range
        : codeLocation && isObject(codeLocation.lineRange)
            ? codeLocation.lineRange
            : null

    return {
        title,
        body,
        priority: asNumber(value.priority),
        confidenceScore: asNumber(value.confidence_score ?? value.confidenceScore),
        filePath: codeLocation ? asString(codeLocation.absolute_file_path ?? codeLocation.absoluteFilePath ?? codeLocation.path) : null,
        lineStart: lineRange ? asNumber(lineRange.start) : null,
        lineEnd: lineRange ? asNumber(lineRange.end) : null
    }
}

function normalizeCodexReviewJson(value: unknown): CodexReview | null {
    if (!isObject(value)) return null
    const hasReviewMarker = Array.isArray(value.findings)
        || 'overall_correctness' in value
        || 'overallCorrectness' in value
        || 'overall_explanation' in value
        || 'overallExplanation' in value
    if (!hasReviewMarker) return null

    const findings = Array.isArray(value.findings)
        ? value.findings
            .map(normalizeCodexReviewFinding)
            .filter((finding): finding is CodexReviewFinding => finding !== null)
        : []

    const overallCorrectness = asString(value.overall_correctness ?? value.overallCorrectness)
    const overallExplanation = asString(value.overall_explanation ?? value.overallExplanation)
    const overallConfidenceScore = asNumber(value.overall_confidence_score ?? value.overallConfidenceScore)

    if (findings.length === 0 && !overallCorrectness && !overallExplanation && overallConfidenceScore === null) {
        return null
    }

    return {
        findings,
        overallCorrectness,
        overallExplanation,
        overallConfidenceScore
    }
}

function parseCodexReviewMessage(message: string): CodexReview | null {
    const trimmed = message.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
    try {
        return normalizeCodexReviewJson(JSON.parse(trimmed) as unknown)
    } catch {
        return null
    }
}

function normalizeAssistantOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown,
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)
    const agentTimestamp = parseAgentTimestampMs(data.timestamp)
    const parentToolUseId = asString(data.parentToolUseId) ?? null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    const blocks: NormalizedAgentContent[] = []

    if (typeof modelContent === 'string') {
        blocks.push({ type: 'text', text: modelContent, uuid, parentUUID })
    } else if (Array.isArray(modelContent)) {
        for (const block of modelContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                blocks.push({ type: 'reasoning', text: block.thinking, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_use' && typeof block.id === 'string') {
                const name = asString(block.name) ?? 'Tool'
                const input = 'input' in block ? (block as Record<string, unknown>).input : undefined
                const description = isObject(input) && typeof input.description === 'string' ? input.description : null
                blocks.push({ type: 'tool-call', id: block.id, name, input, description, uuid, parentUUID })
            }
        }
    }

    const usage = isObject(message.usage) ? (message.usage as Record<string, unknown>) : null
    const inputTokens = usage ? asNumber(usage.input_tokens) : null
    const outputTokens = usage ? asNumber(usage.output_tokens) : null
    const model = asString(message.model) ?? null

    return {
        id: messageId,
        localId,
        createdAt,
        model,
        role: 'agent',
        isSidechain,
        parentToolUseId,
        content: blocks,
        meta,
        agentTimestamp,
        usage: inputTokens !== null && outputTokens !== null ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: asNumber(usage?.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: asNumber(usage?.cache_read_input_tokens) ?? undefined,
            service_tier: asString(usage?.service_tier) ?? undefined,
            context_window: asNumber(usage?.context_window) ?? undefined
        } : undefined
    }
}

function normalizeUserOutput(
    messageId: string,
    localId: string | null,
    createdAt: number,
    data: Record<string, unknown>,
    meta?: unknown,
): NormalizedMessage | null {
    const uuid = asString(data.uuid) ?? messageId
    const parentUUID = asString(data.parentUuid) ?? null
    const isSidechain = Boolean(data.isSidechain)
    const agentTimestamp = parseAgentTimestampMs(data.timestamp)
    const parentToolUseId = asString(data.parentToolUseId) ?? null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const messageContent = message.content

    if (isSidechain && typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            parentToolUseId,
            content: [{ type: 'sidechain', uuid, parentUUID, prompt: messageContent }],
            agentTimestamp
        }
    }

    // Handle system-injected messages that arrive as type:'user' through
    // the agent output path. Real user text goes through normalizeUserRecord.
    //
    // All string-content user messages here are system-injected (subagent
    // prompts, task notifications, system reminders, etc.).  Always emit as
    // sidechain so the uuid/parentUUID chain is preserved — the reducer uses
    // sidechain UUIDs to identify sentinel auto-replies.  Task-notification
    // summaries are extracted as events by the reducer, not here.
    if (typeof messageContent === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'agent',
            isSidechain: true,
            parentToolUseId,
            content: [{ type: 'sidechain', uuid, parentUUID, prompt: messageContent }],
            agentTimestamp
        }
    }

    // Sidechain user messages with array content (e.g. subagent prompts
    // that Claude Code serialised as [{type:'text', text:'...'}] instead
    // of a plain string).  Extract the text and treat as sidechain so the
    // tracer can match it to the parent Task tool call.
    if (isSidechain && Array.isArray(messageContent)) {
        const textParts = messageContent
            .filter((b: unknown) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
            .map((b: Record<string, unknown>) => b.text as string)
        if (textParts.length > 0) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: true,
                parentToolUseId,
                content: [{ type: 'sidechain', uuid, parentUUID, prompt: textParts.join('\n\n') }],
                agentTimestamp
            }
        }
    }

    // Non-sidechain array content that is all text blocks — these are real
    // user messages that the CLI wrapped as agent output because
    // isExternalUserMessage rejects array content. Emit as role:'user' so
    // they display in the user lane.
    if (!isSidechain && Array.isArray(messageContent)) {
        const textParts = messageContent
            .filter((b: unknown) => isObject(b) && b.type === 'text' && typeof b.text === 'string')
            .map((b: Record<string, unknown>) => b.text as string)
        if (textParts.length > 0 && textParts.length === messageContent.length) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: textParts.join('\n\n') },
                meta,
                agentTimestamp
            }
        }
    }

    const blocks: NormalizedAgentContent[] = []

    if (Array.isArray(messageContent)) {
        for (const block of messageContent) {
            if (!isObject(block) || typeof block.type !== 'string') continue
            if (block.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text, uuid, parentUUID })
                continue
            }
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                const isError = Boolean(block.is_error)
                const rawContent = 'content' in block ? (block as Record<string, unknown>).content : undefined
                const embeddedToolUseResult = 'toolUseResult' in data ? (data as Record<string, unknown>).toolUseResult : null

                const permissions = normalizeToolResultPermissions(block.permissions)

                blocks.push({
                    type: 'tool-result',
                    tool_use_id: block.tool_use_id,
                    content: embeddedToolUseResult ?? rawContent,
                    is_error: isError,
                    uuid,
                    parentUUID,
                    permissions
                })
            }
        }
    }

    return {
        id: messageId,
        localId,
        createdAt,
        role: 'agent',
        isSidechain,
        parentToolUseId,
        content: blocks,
        meta,
        agentTimestamp
    }
}

// "RUN_COMMAND" → "Run command", "VIEW_FILE" → "View file".
function humanizeAgyActionType(type: string): string {
    const words = type.toLowerCase().split('_').filter(Boolean)
    if (words.length === 0) return 'Tool'
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
}

// agy wraps each action result with framing that's noise in the chat: bookkeeping
// timestamps, a per-file metadata header (File Path/Total Lines/…) that just
// repeats the card title, the "line-number injected" note, and a model-directed
// instruction appended to write/edit confirmations. Strip all of it and keep the
// substantive result (file content, command output, edit confirmation).
export function stripAgyActionPreamble(content: string, name: string, rawActionName?: string): string {
    let result = content.replace(
        /^(?:Created At:.*(?:\r?\n|$))?(?:Completed At:.*(?:\r?\n|$))?/,
        ''
    )

    if (name === 'Read' || rawActionName === 'VIEW_FILE') {
        result = result
            .replace(/^(?:(?:File Path:|Total Lines:|Total Bytes:|Showing lines\b).*(?:\r?\n|$))+/, '')
            .replace(/^The following code has been modified to include a line number.*(?:\r?\n|$)/, '')
    }

    // An unpaired CODE_ACTION reaches here as "Code action", so gating on the
    // tool name alone would leave agy's model-directed instruction rendered to
    // the user. The action type is unambiguous on its own; the instruction
    // regex below is what actually anchors the strip.
    if (name === 'Write' || name === 'Edit' || rawActionName === 'CODE_ACTION') {
        result = result.replace(/\s*If relevant, proactively run terminal commands[\s\S]*$/, '')
    }

    return result.trim()
}

// agy's view_file result appends a trailing "The above content …" note — either
// "…shows the entire, complete file contents" (full read) or "…does NOT show the
// entire file contents. If you need to view …" (partial read). Strip whichever
// trailer is present (noise, and a non-numbered line would defeat the gutter
// offset below). The per-line "<n>: " prefixes are left in place: they carry the
// TRUE line numbers (important for partial reads), and the code-block renderer
// turns them into a correctly-offset gutter (see parseNumberedFileLines).
export function stripAgyReadArtifacts(content: string): string {
    return content
        .replace(/\n?The above content (?:shows|does NOT show)[\s\S]*$/, '')
        .trimEnd()
}

// agy sometimes echoes an async task's raw result into its own PLANNER_RESPONSE
// prose: "Inside the task-246 log…\n[Message] timestamp=… content=Task id … finished
// with result: … Output: …". That echoed block duplicates the background-task card
// rendered from the corresponding SYSTEM_MESSAGE (and leaks the raw `[Message]`
// framing), so strip it from the "…log…" marker onward and keep only the agent's
// narration. The narration itself is the agent's real words — left intact.
export function stripAgyEchoedTaskResult(text: string): string {
    return text.replace(/\n*\[Message\]\s+timestamp=[\s\S]*$/, '').trim()
}

// Canonical tool id for agy's transitional "Inside the task-NNN log…" narration,
// rendered as a compact Send-Message-style chip instead of a full agent bubble.
export const AGY_TASK_LOG_TOOL = 'AgyTaskLog'

// Canonical tool id for agy's SYSTEM_MESSAGE entries (async/background task
// results). Rendered via a dedicated knownTools presentation (clipboard icon,
// "Background task" title) instead of a mislabeled "System message" tool card.
export const AGY_ASYNC_TASK_TOOL = 'AgyAsyncTask'

/**
 * agy delivers async/background task results as SYSTEM_MESSAGE entries wrapped in
 * framing:
 *   "The following is a <SYSTEM_MESSAGE> not actually sent by the user…
 *    <SYSTEM_MESSAGE>\n[Message] timestamp=… sender=…/task-228 … content=Task id
 *    "…/task-228" finished with result:\n\n<output>\n</SYSTEM_MESSAGE>"
 * Strip the framing to the substantive task result, and derive a one-line
 * summary (task id + outcome) for the card title.
 */
export function parseAgyAsyncTaskMessage(raw: string): { body: string; summary: string; isError: boolean } {
    let body = raw
    const contentEq = raw.indexOf('content=')
    const endTag = raw.indexOf('</SYSTEM_MESSAGE>')
    if (contentEq !== -1) {
        body = raw.slice(contentEq + 'content='.length, endTag !== -1 ? endTag : undefined)
    } else if (endTag !== -1) {
        body = raw.slice(0, endTag)
    }
    // agy pads the task output with leading tabs — de-indent for readability.
    body = body.replace(/^[\t ]+/gm, '').trim()

    const taskMatch = raw.match(/task-(\d+)/)
    const taskLabel = taskMatch ? `task-${taskMatch[1]}` : 'Background task'
    const failMatch = body.match(/failed with exit code:?\s*(\d+)/i)
    const isError = Boolean(failMatch)
    let outcome = ''
    if (failMatch) outcome = `failed (exit ${failMatch[1]})`
    else if (/completed successfully/i.test(body)) outcome = 'completed'
    const summary = outcome ? `${taskLabel} · ${outcome}` : taskLabel
    return { body, summary, isError }
}

// Canonical tool id for agy's ERROR_MESSAGE entries — the runtime's feedback that
// the model emitted a malformed tool call. Rendered via a dedicated knownTools
// error presentation (alert icon, "Invalid tool call") instead of a mislabeled
// "Error message" tool card.
export const AGY_ERROR_TOOL = 'AgyError'

/**
 * agy's ERROR_MESSAGE payload is a tool-call parsing failure plus agent-directed
 * retry boilerplate:
 *   "Created At: …\nError invalid tool call: …\nError Message: … <reason>\n
 *    Guidance: You are trying to correct your previous tool call error … Do not
 *    apologize.\nRetries remaining: 4."
 * Strip the bookkeeping timestamp and the agent-directed guidance/retry counter
 * (noise for a reader), keep the substantive error, and derive a short title.
 */
export function parseAgyErrorMessage(raw: string): { body: string; summary: string } {
    const body = raw
        .replace(/^Created At:.*(?:\r?\n)?/gm, '')
        // Guidance runs to the end of the payload (retry counter included).
        .replace(/\n?Guidance:[\s\S]*$/, '')
        .replace(/\n?Retries remaining:.*$/m, '')
        .trim()
    const summary = /invalid tool call/i.test(raw) ? 'Invalid tool call' : 'Error'
    return { body, summary }
}

// agy names its tools differently from claude (run_command vs Bash, …) and its
// args use different keys per tool (write_to_file.CodeContent vs Write.content).
// Map the ones with a clear equivalent to the canonical tool id AND translate
// their args into the fields that tool's view reads, so the ToolCard renders the
// same rich view as the other flavors (Bash command, Read/Write file, Edit diff).
// Anything unmapped keeps its humanized label + generic key/value input.
type AgyToolSpec = { name: string; buildInput: (args: Record<string, unknown>) => Record<string, unknown> }
const AGY_TOOL_SPECS: Record<string, AgyToolSpec> = {
    run_command: { name: 'Bash', buildInput: (a) => ({ command: a.CommandLine, cwd: a.Cwd }) },
    view_file: { name: 'Read', buildInput: (a) => ({ file_path: a.AbsolutePath ?? a.RelativePath }) },
    // Write: the view renders input.content under the file path.
    write_to_file: { name: 'Write', buildInput: (a) => ({ file_path: a.TargetFile, content: a.CodeContent }) },
    // Edit: the view renders a diff from old_string → new_string.
    replace_file_content: {
        name: 'Edit',
        buildInput: (a) => ({ file_path: a.TargetFile, old_string: a.TargetContent, new_string: a.ReplacementContent }),
    },
    grep_search: { name: 'Grep', buildInput: (a) => ({ pattern: a.Query ?? a.SearchQuery, path: a.SearchDirectory ?? a.SearchPath }) },
    list_dir: { name: 'LS', buildInput: (a) => ({ path: a.DirectoryPath ?? a.AbsolutePath }) },
}

// agy arg keys → the canonical input field names the ToolCard presentations read
// (command, file_path, pattern, …). Lets a Bash/Read card surface the command or
// path in its subtitle instead of showing nothing.
const AGY_ARG_KEY_MAP: Record<string, string> = {
    CommandLine: 'command',
    Cwd: 'cwd',
    AbsolutePath: 'file_path',
    RelativePath: 'file_path',
    TargetFile: 'file_path',
    FilePath: 'file_path',
    Path: 'path',
    DirectoryPath: 'path',
    Query: 'query',
    SearchQuery: 'query',
    Pattern: 'pattern',
    Url: 'url',
    URL: 'url',
}

// Bookkeeping args that aren't worth showing as tool input.
const AGY_ARG_NOISE = new Set(['toolAction', 'toolSummary', 'WaitMsBeforeAsync', 'Blocking'])

function normalizeAgyToolInput(args: Record<string, unknown>): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
        if (AGY_ARG_NOISE.has(key)) continue
        if (value === null || value === undefined || value === '') continue
        out[AGY_ARG_KEY_MAP[key] ?? key] = value
    }
    return Object.keys(out).length > 0 ? out : undefined
}

// Build the tool-call presentation for an agy action from the paired invocation
// (toolName + raw args) the CLI forwards. Falls back to the humanized action
// type when no invocation was paired (older sessions / unmatched actions).
function mapAgyToolCall(
    toolName: string | null | undefined,
    actionType: string,
    args: Record<string, unknown> | undefined
): { name: string; input: Record<string, unknown> | undefined; description: string | null } {
    // agy attaches a one-line human summary of the action; use it as the card
    // description (the title slot) for a readable label.
    const description = args ? asString(args.toolSummary) ?? null : null
    const spec = toolName ? AGY_TOOL_SPECS[toolName] : undefined
    if (spec) {
        // Translate agy's per-tool args into the fields that tool's view reads,
        // dropping empties so an absent optional arg doesn't render a blank row.
        const built: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(spec.buildInput(args ?? {}))) {
            if (value !== null && value !== undefined && value !== '') built[key] = value
        }
        return { name: spec.name, input: Object.keys(built).length > 0 ? built : undefined, description }
    }
    // Unmapped tool: keep a humanized label, generic key/value input.
    const name = humanizeAgyActionType(toolName ?? actionType)
    const input = args ? normalizeAgyToolInput(args) : undefined
    return { name, input, description }
}

export function isSkippableAgentContent(content: unknown): boolean {
    if (!isObject(content) || content.type !== 'output') return false
    const data = isObject(content.data) ? content.data : null
    if (!data) return false
    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) return true
    // A recap with no text is pure noise — drop it here rather than let it reach
    // the away_summary branch (a bare "recap:" row) or, via a null return, fall
    // through to the raw-JSON stringify fallback in normalize.ts.
    if (data.type === 'system' && data.subtype === 'away_summary' && !asString(data.content)?.trim()) return true
    // Empty agy planner steps (no text, no tool calls) carry nothing to render —
    // skip cleanly so they don't fall through to the raw-JSON stringify fallback.
    if (data.type === 'agy_message' && !(asString(data.content) ?? '').trim()) return true
    return !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

export function isCodexContent(content: unknown): boolean {
    return isObject(content) && content.type === AGENT_MESSAGE_PAYLOAD_TYPE
}

export function normalizeAgentRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown,
): NormalizedMessage | null {
    if (!isObject(content) || typeof content.type !== 'string') return null

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        // Skip meta/compact-summary messages (parity with hapi-app)
        if (data.isMeta) return null
        if (data.isCompactSummary) return null
        if (!isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) return null

        if (data.type === 'assistant') {
            return normalizeAssistantOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'user') {
            return normalizeUserOutput(messageId, localId, createdAt, data, meta)
        }
        if (data.type === 'summary' && typeof data.summary === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'summary', summary: data.summary }],
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'api_error') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'api-error',
                    retryAttempt: asNumber(data.retryAttempt) ?? 0,
                    maxRetries: asNumber(data.maxRetries) ?? 0,
                    error: data.error
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'turn_duration') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'turn-duration',
                    durationMs: asNumber(data.durationMs) ?? 0,
                    targetMessageId: asString(data.messageId) ?? undefined
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'away_summary') {
            // Recap text lives in `content`. Empty recaps are dropped upstream by
            // isSkippableAgentContent, so content is a non-empty string here.
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'recap',
                    text: asString(data.content) ?? ''
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'microcompact_boundary') {
            const metadata = isObject(data.microcompactMetadata) ? data.microcompactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'microcompact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0,
                    tokensSaved: asNumber(metadata?.tokensSaved) ?? 0
                },
                isSidechain: false,
                meta
            }
        }
        if (data.type === 'system' && data.subtype === 'compact_boundary') {
            const metadata = isObject(data.compactMetadata) ? data.compactMetadata : null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    trigger: asString(metadata?.trigger) ?? 'auto',
                    preTokens: asNumber(metadata?.preTokens) ?? 0
                },
                isSidechain: false,
                meta
            }
        }

        // agy (Antigravity) PTY messages — render the actual response text and
        // tool calls instead of falling through to the raw-JSON stringify
        // fallback. Empty planner steps (intermediate, no content) are skipped so
        // they don't produce empty chat bubbles.
        if (data.type === 'agy_message') {
            const text = stripAgyEchoedTaskResult(asString(data.content) ?? '')
            if (!text.trim()) return null
            // Transitional "Inside the task-NNN log…" narration → a compact
            // Send-Message-style chip, not a full agent bubble. The actual task
            // result renders in its own background-task card, so this stays a thin
            // marker of what the agent is doing.
            const taskLog = text.match(/^Inside the task-(\d+) log\b/)
            if (taskLog) {
                const toolCallId = `${messageId}:tasklog`
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [
                        { type: 'tool-call', id: toolCallId, name: AGY_TASK_LOG_TOOL, input: { task: `task-${taskLog[1]}` }, description: null, uuid: messageId, parentUUID: null },
                        { type: 'tool-result', tool_use_id: toolCallId, content: '', is_error: false, uuid: messageId, parentUUID: null }
                    ],
                    meta
                }
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text, uuid: messageId, parentUUID: null }],
                // Per-turn model (display name from the conversation DB), surfaced
                // in the message metadata footer like the other flavors.
                model: asString(data.model) ?? null,
                meta
            }
        }
        // agy tool ACTION (VIEW_FILE, RUN_COMMAND, …): render as a collapsible tool
        // card keyed by the (humanized) action type, with the result as detail —
        // instead of dumping the raw result text as a chat bubble.
        if (data.type === 'agy_tool_action') {
            const rawActionName = asString(data.name) ?? 'Tool'
            // Key the tool-call by conversationId:stepIdx when present — the SAME id
            // the PreToolUse permission request uses — so a gated tool's approval
            // card and this result merge into ONE card (no stuck "running"
            // duplicate), while the pending approval still shows in real time.
            // Falls back to messageId for auto-allowed tools (no permission raised).
            const toolCallId = asString(data.toolUseId) ?? messageId

            let name: string
            let input: Record<string, unknown> | undefined
            let description: string | null
            let content: string
            let isError = false
            if (rawActionName === 'SYSTEM_MESSAGE') {
                // Not a real tool call — a deferred async/background task result.
                // Strip the "<SYSTEM_MESSAGE> not actually sent by the user…"
                // framing and render it as a dedicated background-task card so the
                // output stays visible without masquerading as an invocation.
                const parsed = parseAgyAsyncTaskMessage(asString(data.content) ?? '')
                name = AGY_ASYNC_TASK_TOOL
                input = undefined
                description = parsed.summary
                content = parsed.body
                isError = parsed.isError
            } else if (rawActionName === 'ERROR_MESSAGE') {
                // Not a tool result — agy's feedback that the model emitted a
                // malformed tool call (with agent-directed retry guidance). Render
                // as a dedicated error card so it reads as a failure, not a
                // mislabeled "Error message" tool invocation.
                const parsed = parseAgyErrorMessage(asString(data.content) ?? '')
                name = AGY_ERROR_TOOL
                input = undefined
                description = parsed.summary
                content = parsed.body
                isError = true
            } else {
                // Pair the invocation (toolName + input) the CLI forwarded from the
                // preceding PLANNER_RESPONSE with this action's result, so the card
                // shows the command/path/args like the other flavors instead of
                // just the raw result blob.
                const mapped = mapAgyToolCall(
                    asString(data.toolName),
                    rawActionName,
                    isObject(data.input) ? data.input : undefined
                )
                name = mapped.name
                input = mapped.input
                description = mapped.description
                content = stripAgyActionPreamble(asString(data.content) ?? '', name, rawActionName)
                // view_file → Read: also drop agy's per-line "<n>: " prefixes and
                // the "The above content shows…" trailer so the code block renders
                // clean, single-gutter line numbers.
                if (name === 'Read' || rawActionName === 'VIEW_FILE') content = stripAgyReadArtifacts(content)
            }
            // agy action entries are already DONE, so pair the tool-call with a
            // tool-result (matching ids) — that makes the card render as COMPLETED
            // (with its result) instead of perpetually "Running".
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: toolCallId,
                        name,
                        input,
                        description,
                        nativeKind: name === 'Read' || rawActionName === 'VIEW_FILE'
                            ? 'agy-numbered-read'
                            : null,
                        uuid: messageId,
                        parentUUID: null
                    },
                    {
                        type: 'tool-result',
                        tool_use_id: toolCallId,
                        content,
                        is_error: isError,
                        uuid: messageId,
                        parentUUID: null
                    }
                ],
                meta
            }
        }
        return null
    }

    if (content.type === 'event') {
        const event = normalizeAgentEvent(content.data)
        if (!event) return null
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'event',
            content: event,
            isSidechain: false,
            meta
        }
    }

    if (content.type === AGENT_MESSAGE_PAYLOAD_TYPE) {
        const data = isObject(content.data) ? content.data : null
        if (!data || typeof data.type !== 'string') return null

        if (
            data.type === 'agent-run-start'
            || data.type === 'agent-run-update'
            || data.type === 'agent-run-trace'
        ) {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: data as AgentEvent,
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'generated-image') {
            const imageId = asString(data.imageId ?? data.image_id)
            if (!imageId) return null
            const uuid = asString(data.id) ?? messageId
            const source = inlineMediaSourceFromWire(data.source)
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'generated-image',
                    imageId,
                    fileName: asString(data.fileName ?? data.file_name) ?? 'generated-image',
                    mimeType: asString(data.mimeType ?? data.mime_type),
                    uuid,
                    parentUUID: null,
                    source,
                }],
                meta
            }
        }

        if (data.type === 'error' && typeof data.message === 'string') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'error',
                    message: data.message
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'message' && typeof data.message === 'string') {
            const streamId = asString(data.id)
            const isPiStreamSnapshot = data.streamSnapshot === true
                || (streamId !== null && /^pi-.+-turn-\d+-message-\d+-text-\d+$/.test(streamId))
            const review = isPiStreamSnapshot ? null : parseCodexReviewMessage(data.message)
            if (review) {
                return {
                    id: messageId,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'codex-review', review, uuid: messageId, parentUUID: null }],
                    meta
                }
            }
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: data.message,
                    uuid: messageId,
                    ...(streamId !== null ? { streamId } : {}),
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'reasoning' && typeof data.message === 'string') {
            const streamId = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'reasoning', text: data.message, uuid: messageId, streamId, parentUUID: null }],
                meta
            }
        }

        if (data.type === 'context_compacted') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'compact',
                    trigger: asString(data.trigger) ?? 'auto',
                    preTokens: asNumber(data.preTokens ?? data.pre_tokens) ?? 0
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'token_count') {
            const usage = normalizeCodexTokenUsage(data.info, data)
            return usage ? {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'token-count',
                    info: data.info
                },
                isSidechain: false,
                meta,
                usage
            } : null
        }

        if (data.type === 'thread_goal_updated') {
            const goal = normalizeThreadGoal(data.goal)
            if (!goal) return null
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'thread-goal-updated',
                    threadId: asString(data.threadId ?? data.thread_id) ?? goal.threadId,
                    turnId: asString(data.turnId ?? data.turn_id) ?? undefined,
                    goal
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'thread_goal_cleared') {
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'event',
                content: {
                    type: 'thread-goal-cleared',
                    threadId: asString(data.threadId ?? data.thread_id) ?? undefined
                },
                isSidechain: false,
                meta
            }
        }

        if (data.type === 'tool-call' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: asString(data.name) ?? 'unknown',
                    input: data.input,
                    description: asString(data.description),
                    nativeTitle: asString(data.nativeTitle ?? data.title),
                    nativeKind: asString(data.nativeKind ?? data.kind),
                    ...('progress' in data ? { progress: data.progress } : {}),
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: Boolean(data.is_error),
                    uuid,
                    parentUUID: null
                }],
                meta
            }
        }

        if (data.type === 'plan') {
            const plan = normalizePlanEntries(data.entries ?? data.items ?? data)
            if (plan.length === 0) return null
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'cursor-plan-state',
                        name: 'update_plan',
                        input: {
                            plan,
                            source: 'cursor'
                        },
                        description: null,
                        uuid,
                        parentUUID: null
                    },
                    {
                        type: 'tool-result',
                        tool_use_id: 'cursor-plan-state',
                        content: {
                            plan,
                            source: 'cursor'
                        },
                        is_error: false,
                        uuid,
                        parentUUID: null
                    }
                ],
                meta
            }
        }

        if (data.type === 'plan_update') {
            const plan = normalizePlanEntries(data.plan ?? data.update ?? data.items ?? data.steps ?? data)
            if (plan.length === 0) return null
            const uuid = asString(data.id) ?? messageId
            return {
                id: messageId,
                localId,
                createdAt,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'codex-plan-state',
                        name: 'update_plan',
                        input: {
                            plan,
                            source: 'codex'
                        },
                        description: null,
                        uuid,
                        parentUUID: null
                    },
                    {
                        type: 'tool-result',
                        tool_use_id: 'codex-plan-state',
                        content: {
                            plan,
                            source: 'codex',
                            status: 'updated'
                        },
                        is_error: false,
                        uuid: `${uuid}:result`,
                        parentUUID: null
                    }
                ],
                meta
            }
        }
    }

    return null
}
