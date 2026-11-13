import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { isObject } from '@hapi/protocol'
import type { AgentStateCompletedRequest, AgentStateRequest } from '@hapi/protocol/schemas'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler'
import { buildAskUserQuestionUpdatedInput } from './askUserQuestionAnswers'
import {
    type LocalPermissionDecision,
    type PermissionRequestHook
} from './localPermissionProtocol'
import type { SessionHookData } from './startHookServer'

const REQUEST_PREFIX = 'claude-local:'
const MAX_OBSERVED_CALLS = 256
const responseSchema = z.object({
    id: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
    mode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']).optional(),
    allowTools: z.array(z.string()).optional(),
    answers: z.union([
        z.record(z.string(), z.array(z.string().min(1)).min(1)),
        z.record(z.string(), z.object({ answers: z.array(z.string().min(1)).min(1) }))
    ]).optional()
})
const questionsSchema = z.array(z.object({ question: z.string().min(1) })).min(1).max(4)

type ObservedCall = {
    tool: string
    input: Record<string, unknown>
    promptId?: string
    claimed: boolean
}
type PendingRequest = {
    id: string
    entry: AgentStateRequest & { toolCallId: string }
    hookSettled: boolean
    resolve: (decision: LocalPermissionDecision | null) => void
    detach: () => void
}

/**
 * Main-thread local permissions only. Claude, not HAPI, arbitrates the native
 * dialog versus the hook. Sending a verdict is NOT proof that it won the race;
 * only native tool lifecycle/transcript results complete the corresponding UI.
 */
export class LocalPermissionBridge {
    private active = false
    private nativeSessionId: string | null = null
    private readonly calls = new Map<string, ObservedCall>()
    private readonly pending = new Map<string, PendingRequest>()

    constructor(private readonly client: PermissionHandlerClient) {}

    start(nativeSessionId: string | null): void {
        this.stop()
        this.active = true
        this.nativeSessionId = nativeSessionId
        // A resumed HAPI session may retain requests from a dead local process.
        this.client.updateAgentState(state => ({
            ...state,
            requests: Object.fromEntries(Object.entries(state.requests ?? {}).filter(([id]) => !id.startsWith(REQUEST_PREFIX)))
        }))
        this.client.rpcHandlerManager.registerHandler(RPC_METHODS.Permission, (response: unknown) => this.respond(response))
    }

    stop = (): void => {
        this.active = false
        this.cancelAll('Local permission bridge closed')
        this.nativeSessionId = null
    }

    onHook(data: SessionHookData): void {
        // Background subagents have different (blocking-before-dialog) hook
        // semantics. Do not intercept their requests or adopt their session id.
        if (!this.active || data.agent_id !== undefined) return
        if (data.hook_event_name === 'SessionStart' && typeof data.session_id === 'string') {
            if (this.nativeSessionId !== data.session_id) this.cancelAll('Claude session changed')
            this.nativeSessionId = data.session_id
        }
        if (!this.nativeSessionId || data.session_id !== this.nativeSessionId) return

        if (data.hook_event_name === 'SessionEnd') {
            // /clear and /resume end a native session without exiting the
            // local process. Keep this activation ready for its next start.
            this.cancelAll('Claude session ended')
            this.nativeSessionId = null
        } else if (data.hook_event_name === 'UserPromptSubmit') {
            this.cancelAll('A new local prompt superseded the request')
        } else if (data.hook_event_name === 'PreToolUse') {
            if (typeof data.tool_use_id !== 'string' || typeof data.tool_name !== 'string' || !isObject(data.tool_input)) return
            if (this.calls.has(data.tool_use_id)) return
            this.calls.set(data.tool_use_id, {
                tool: data.tool_name,
                input: data.tool_input,
                promptId: typeof data.prompt_id === 'string' ? data.prompt_id : undefined,
                claimed: false
            })
            if (this.calls.size > MAX_OBSERVED_CALLS) {
                const oldest = this.calls.keys().next().value
                if (oldest) this.finishTool(oldest, 'canceled', 'Remote permission tracking expired')
            }
        } else if (data.hook_event_name === 'PostToolUse' || data.hook_event_name === 'PostToolUseFailure') {
            if (typeof data.tool_use_id === 'string') {
                // Even a failed execution proves that permission was granted.
                this.finishTool(data.tool_use_id, 'approved', undefined, data.tool_response)
            }
        }
    }

    /** The JSONL mirror is essential: Esc can emit a tool_result without any completion hook. */
    onTranscript(message: unknown): void {
        if (!this.active || !isObject(message) || message.isSidechain === true) return
        if (typeof message.sessionId === 'string' && message.sessionId !== this.nativeSessionId) return
        if (!isObject(message.message) || !Array.isArray(message.message.content)) return
        for (const block of message.message.content) {
            if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
            this.finishTool(
                block.tool_use_id,
                block.is_error === true ? 'canceled' : 'approved',
                block.is_error === true ? 'The local tool call was canceled or failed' : undefined,
                message.toolUseResult
            )
        }
    }

    request(data: PermissionRequestHook, signal: AbortSignal): Promise<LocalPermissionDecision | null> {
        if (!this.active || signal.aborted || data.agent_id !== undefined || data.session_id !== this.nativeSessionId) {
            return Promise.resolve(null)
        }
        // Plan-mode transitions need their own UX/permission-mode semantics.
        if (data.tool_name === 'ExitPlanMode') return Promise.resolve(null)
        if (data.tool_name === 'AskUserQuestion') {
            const questions = questionsSchema.safeParse(data.tool_input.questions)
            if (!questions.success || new Set(questions.data.map(q => q.question)).size !== questions.data.length) {
                return Promise.resolve(null)
            }
        }
        // PermissionRequest deliberately lacks tool_use_id. Correlate only an
        // unambiguous observed main-thread call in this prompt, never "latest by
        // tool name". Ambiguous or unobserved requests remain native-only.
        const matches = [...this.calls].filter(([, call]) => call.tool === data.tool_name
            && call.promptId === data.prompt_id && isDeepStrictEqual(call.input, data.tool_input))
        if (matches.length !== 1 || matches[0][1].claimed) return Promise.resolve(null)
        const [toolCallId, call] = matches[0]
        call.claimed = true
        const id = REQUEST_PREFIX + randomUUID()
        return new Promise(resolve => {
            // Timeout/disconnection ends remote input, not the native question.
            // Keep observing its real result while the local process is alive.
            const onAbort = () => this.release(pending, null)
            const pending: PendingRequest = {
                id,
                entry: { tool: call.tool, arguments: data.tool_input, toolCallId, createdAt: Date.now() },
                hookSettled: false,
                resolve,
                detach: () => signal.removeEventListener('abort', onAbort)
            }
            this.pending.set(id, pending)
            signal.addEventListener('abort', onAbort, { once: true })
            this.client.updateAgentState(state => ({ ...state, requests: { ...state.requests, [id]: pending.entry } }))
        })
    }

    private respond(raw: unknown): void {
        const response = responseSchema.parse(raw)
        const pending = this.pending.get(response.id)
        if (!this.active || !pending || pending.hookSettled) throw new Error('Local request is no longer answerable')
        const input = pending.entry.arguments
        if (!isObject(input)) throw new Error('Invalid local tool input')
        let decision: LocalPermissionDecision
        if (!response.approved) {
            decision = { behavior: 'deny', message: response.reason ?? 'The user declined this request.' }
        } else if (pending.entry.tool === 'AskUserQuestion') {
            const questions = questionsSchema.parse(input.questions)
            const answers = response.answers ?? {}
            if (questions.some((_, i) => !answers[String(i)])) throw new Error('Answer every question before submitting')
            decision = { behavior: 'allow', updatedInput: buildAskUserQuestionUpdatedInput(input, answers) }
        } else {
            const updatedPermissions: NonNullable<LocalPermissionDecision['updatedPermissions']> = []
            if (response.mode) updatedPermissions.push({ type: 'setMode', mode: response.mode, destination: 'session' })
            if (response.allowTools?.length) {
                const rules = response.allowTools.map(rule => {
                    const match = /^([^()]+)(?:\((.*)\))?$/s.exec(rule)
                    if (!match) throw new Error('Invalid tool permission rule')
                    return { toolName: match[1], ...(match[2] !== undefined ? { ruleContent: match[2] } : {}) }
                })
                updatedPermissions.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' })
            }
            decision = { behavior: 'allow', updatedInput: input, ...(updatedPermissions.length ? { updatedPermissions } : {}) }
        }
        this.release(pending, decision)
    }

    private release(pending: PendingRequest, decision: LocalPermissionDecision | null): void {
        pending.hookSettled = true
        pending.detach()
        // Stop exposing an actionable footer, but don't falsely record this
        // answer as accepted: the native dialog may already have won.
        this.removeRequest(pending.id)
        pending.resolve(decision)
    }

    private removeRequest(id: string): void {
        this.client.updateAgentState(state => {
            const requests = { ...state.requests }
            delete requests[id]
            return { ...state, requests }
        })
    }

    private finishTool(toolCallId: string, status: AgentStateCompletedRequest['status'], reason?: string, result?: unknown): void {
        this.calls.delete(toolCallId)
        for (const [id, pending] of this.pending) {
            if (pending.entry.toolCallId === toolCallId) this.finish(id, status, reason, result)
        }
    }

    private finish(id: string, status: AgentStateCompletedRequest['status'], reason?: string, result?: unknown): void {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.detach()
        pending.resolve(null)
        // Prefer actual native answers (including when the terminal won), not
        // the verdict we merely sent. Never parse comma-separated free text.
        let answers: Record<string, string[]> | undefined
        const input = pending.entry.arguments
        if (isObject(result) && isObject(result.answers) && isObject(input) && Array.isArray(input.questions)) {
            const actual = result.answers
            answers = Object.fromEntries(input.questions.flatMap((q, i) =>
                isObject(q) && typeof q.question === 'string' && typeof actual[q.question] === 'string'
                    ? [[String(i), [actual[q.question] as string]]]
                    : []))
        }
        this.client.updateAgentState(state => {
            const requests = { ...state.requests }
            delete requests[id]
            return {
                ...state, requests,
                completedRequests: {
                    ...state.completedRequests,
                    [id]: { ...pending.entry, status, completedAt: Date.now(), ...(reason ? { reason } : {}), ...(answers ? { answers } : {}) }
                }
            }
        })
    }

    private cancelAll(reason: string): void {
        for (const id of this.pending.keys()) this.finish(id, 'canceled', reason)
        this.calls.clear()
    }
}
