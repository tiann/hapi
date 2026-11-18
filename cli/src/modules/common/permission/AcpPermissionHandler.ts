import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { randomUUID } from 'node:crypto'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type AutoApprovalRuleSet,
    type PendingPermissionRequest,
    type PermissionCompletion
} from './BasePermissionHandler'
import { mapAskUserAnswers, type AskUserAnswer } from './askUserAnswers'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    reason?: string
    /** AskUserQuestion payloads from web/mobile: Record<questionIndex, string[]>
     * (labels + free-text "Other" appended). Absent on plain approve/deny. */
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
}

export type UserAnswer = {
    decision: NonNullable<PermissionResponseMessage['decision']>
    answers?: Record<string, string[]>
}

/** Outcome of a synthetic ask-user escalation surfaced to the HAPI client. */
export type AcpAskUserOutcome =
    | { status: 'answered'; answers: AskUserAnswer[] }
    | { status: 'denied'; reason?: string }
    | { status: 'canceled'; reason?: string }

/**
 * Translate the MCP `ask_user_question` spelling onto the card dialect every
 * HAPI client renders. The MCP schema accepts snake_case (`multi_select`),
 * while the web/iOS/Android AskUserQuestion cards read camelCase
 * (`multiSelect`) — without this, a multi-select question silently renders
 * as single-select and the client forbids choosing more than one option.
 * Unknown payloads pass through unchanged; `multi_select` is kept alongside
 * so snake_case consumers keep working.
 */
function normalizeAskUserQuestionCardInput(input: unknown): unknown {
    if (!input || typeof input !== 'object') return input
    const root = input as { questions?: unknown }
    if (!Array.isArray(root.questions)) return input
    return {
        ...root,
        questions: root.questions.map((question) => {
            if (!question || typeof question !== 'object') return question
            const record = question as Record<string, unknown>
            if (record.multiSelect !== undefined || typeof record.multi_select !== 'boolean') return question
            return { ...record, multiSelect: record.multi_select }
        })
    }
}

function pickOptionId(request: PermissionRequest, preferredKinds: string[]): string | null {
    for (const kind of preferredKinds) {
        const match = request.options.find((option) => option.kind === kind)
        if (match) return match.optionId
    }
    return request.options[0]?.optionId ?? null
}

function mapDecisionToOutcome(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision']
): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' }
    if (decision === 'approved_for_session') {
        const optionId = pickOptionId(request, ['allow_always', 'allow_once'])
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    if (decision === 'approved') {
        const optionId = pickOptionId(request, ['allow_once', 'allow_always'])
        return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
    }
    const optionId = pickOptionId(request, ['reject_once', 'reject_always'])
    return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
}

/** Shared HAPI permission bridge for ACP agents with one-shot choices. */
export class AcpPermissionHandler extends BasePermissionHandler<PermissionResponseMessage, void> {
    /** Synthetic ask-user escalations (MCP ask_user_question bridge). Keyed by
     * the same request id registered in the agent-state pending map; resolved
     * from Permission responses that carry `answers`. */
    private readonly askUserResolvers = new Map<string, (outcome: AcpAskUserOutcome) => void>()
    private readonly pendingBackendRequests = new Map<string, PermissionRequest>()
    private readonly userWaitEnds = new Map<string, () => void>()
    private readonly userQuestions = new Map<string, (answer: UserAnswer) => void>()
    // Clients hide a pending request whose id was already completed.
    private readonly usedIds = new Set<string>()

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend,
        private readonly getPermissionMode: () => PermissionMode | undefined,
        private readonly options: {
            // Agents that title requests with free text (agy: the command
            // line) turn off the HAPI tool-name hints, which could match it.
            autoApprovalRules?: AutoApprovalRuleSet
            // A long-lived agent process outlives mode switches, so automatic
            // approvals must not leave standing grants behind.
            autoApproveOnce?: boolean
            // Questions need the user's answer in every mode.
            requiresUser?: (request: PermissionRequest) => boolean
            // Called when a request starts waiting for the user; the returned
            // callback runs once it is answered (agents timing their own work).
            onUserWait?: () => () => void
            // Called synchronously when a permission 'abort' decision cancels
            // the prompt through the backend directly (never via the
            // launcher's abort handler). Flavors that track cancels — e.g.
            // dsh's implicit session-end detection on custom wrappers that
            // close the session on session/cancel — use this to arm their
            // detector for that cancel.
            onCancelIssued?: () => void
        } = {}
    ) {
        super(session)
        this.backend.onPermissionRequest((request) => this.handlePermissionRequest(request))
    }

    private handlePermissionRequest(request: PermissionRequest): void {
        const toolName = deriveToolName({
            title: request.title,
            kind: request.kind,
            rawInput: request.rawInput
        })
        const toolInput = deriveToolInput(request)
        const autoDecision = this.options.requiresUser?.(request)
            ? null
            : this.resolveAutoApprovalDecision(
                this.getPermissionMode(),
                toolName,
                request.toolCallId,
                this.options.autoApprovalRules
            )
        if (autoDecision) {
            const decision = this.options.autoApproveOnce && autoDecision === 'approved_for_session'
                ? 'approved'
                : autoDecision
            void this.autoApprove(request, toolName, toolInput, decision)
            return
        }

        this.pendingBackendRequests.set(request.id, request)
        this.usedIds.add(request.id)
        this.startUserWait(request.id)
        this.addPendingRequest(request.id, toolName, toolInput, {
            resolve: () => {},
            reject: () => {}
        }, request.toolCallId)
        logger.debug(`[ACP] Permission request queued for ${toolName} (${request.id})`)
    }

    private async autoApprove(
        request: PermissionRequest,
        toolName: string,
        toolInput: unknown,
        decision: AutoApprovalDecision
    ): Promise<void> {
        await this.backend.respondToPermission(request.sessionId, request, mapDecisionToOutcome(request, decision))
        const timestamp = Date.now()
        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [request.id]: {
                    tool: toolName,
                    arguments: toolInput,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        }))
    }

    /**
     * A question the agent asks the user, shown as `toolName` with `input`.
     * Never answered automatically, whatever the permission mode.
     */
    askUser(id: string, toolName: string, input: unknown): Promise<UserAnswer> {
        return new Promise((resolve) => {
            this.userQuestions.set(id, resolve)
            this.usedIds.add(id)
            this.startUserWait(id)
            this.addPendingRequest(id, toolName, input, { resolve: () => {}, reject: () => {} })
        })
    }

    /**
     * Surface an `ask_user_question` payload to the HAPI user and await the
     * answer batch.
     *
     * For agents whose ACP profile ships no native ask-user tool (DSH's
     * automation-only profile deliberately omits it — there is no UI to
     * answer it over raw ACP), the hapi MCP bridge provides the tool instead
     * and routes the question through this escalation. The pending request is
     * registered in the agent state under the exact tool name
     * `ask_user_question` with the questions as arguments, which every HAPI
     * client (web/iOS/Android) already renders as the interactive
     * AskUserQuestion card and answers through approvePermission({answers}) —
     * the same path Claude Code's native AskUserQuestion takes. No backend
     * request exists for these ids: the response resolves the caller directly
     * (the MCP tool returns the answer batch to the model in-band).
     */
    askUserQuestion(input: unknown): Promise<AcpAskUserOutcome> {
        return new Promise<AcpAskUserOutcome>((resolve) => {
            // Supersede: some agents enforce a per-call MCP timeout they
            // cannot raise (DSH: 60s), so an unanswered question times out and
            // the model retries the tool call — escalating a SECOND question
            // while the first card is still pending. Without this, retry
            // cycles stack interactive cards and the turn-end cancelAll
            // silently settles cards the user is mid-way through filling. At
            // most ONE ask-user card may be pending: resolve every prior one
            // as canceled (state entry moves to completedRequests with the
            // reason) the instant a newer question arrives.
            if (this.askUserResolvers.size > 0) {
                this.cancelPendingRequests({
                    completedReason: 'Superseded by a newer question',
                    rejectMessage: 'Superseded by a newer question',
                    filter: (toolName) => toolName === 'ask_user_question'
                });
            }
            const id = `askuser-${randomUUID()}`
            this.askUserResolvers.set(id, resolve)
            this.usedIds.add(id)
            this.startUserWait(id)
            this.addPendingRequest(id, 'ask_user_question', normalizeAskUserQuestionCardInput(input), {
                resolve: () => {},
                reject: (error) => {
                    this.askUserResolvers.delete(id)
                    this.endUserWait(id)
                    resolve({ status: 'canceled', reason: error.message })
                }
            })
        })
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const askUserResolver = this.askUserResolvers.get(response.id)
        if (askUserResolver) {
            this.askUserResolvers.delete(response.id)
            this.endUserWait(response.id)
            if (response.approved) {
                const answers = mapAskUserAnswers(pending.input, response.answers)
                const hasAnyAnswer = answers.some((answer) => answer.selected.length > 0 || answer.custom !== undefined)
                askUserResolver(hasAnyAnswer
                    ? { status: 'answered', answers }
                    : { status: 'denied', reason: response.reason ?? 'No answers were provided.' })
            } else {
                askUserResolver({ status: 'denied', reason: response.reason })
            }
            pending.resolve()
            return {
                status: response.approved ? 'approved' : 'denied',
                decision: response.decision,
                reason: response.reason,
                answers: response.answers
            }
        }

        const question = this.userQuestions.get(response.id)
        if (question) {
            this.userQuestions.delete(response.id)
            const decision = response.decision ?? (response.approved ? 'approved' : 'denied')
            this.endUserWait(response.id)
            // UserAnswer keeps the flat dialect; the nested {answers} spelling
            // is normalized by the ask-user channel (mapAskUserAnswers).
            question(response.answers ? { decision, answers: response.answers as Record<string, string[]> } : { decision })
            pending.resolve()
            return {
                status: response.approved ? 'approved' : 'denied',
                decision,
                reason: response.reason,
                answers: response.answers
            }
        }
        const request = this.pendingBackendRequests.get(response.id)
        this.pendingBackendRequests.delete(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')

        if (decision === 'abort' && request) {
            this.options.onCancelIssued?.()
            await this.backend.cancelPrompt(request.sessionId)
        }
        if (request) {
            await this.backend.respondToPermission(request.sessionId, request, mapDecisionToOutcome(request, decision))
        }
        this.endUserWait(response.id)
        pending.resolve()

        return {
            status: response.approved ? 'approved' : 'denied',
            decision,
            reason: response.reason
        }
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[ACP] Permission response received for unknown request', response.id)
    }

    private startUserWait(id: string): void {
        const end = this.options.onUserWait?.()
        if (end) this.userWaitEnds.set(id, end)
    }

    private endUserWait(id: string): void {
        const end = this.userWaitEnds.get(id)
        this.userWaitEnds.delete(id)
        end?.()
    }

    /** Whether a request with this id is open or was already shown. */
    isUsed(id: string): boolean {
        return this.usedIds.has(id) || this.pendingRequests.has(id)
    }

    hasPendingRequests(): boolean {
        return this.pendingBackendRequests.size > 0 || this.userQuestions.size > 0 || this.askUserResolvers.size > 0
    }

    async cancelAll(reason: string): Promise<void> {
        // Questions first: answering them cannot fail, while a permission
        // reply can throw once the agent process is gone.
        const questions = Array.from(this.userQuestions.entries())
        this.userQuestions.clear()
        for (const [id, answer] of questions) {
            this.endUserWait(id)
            answer({ decision: 'abort' })
        }
        const pending = Array.from(this.pendingBackendRequests.values())
        this.pendingBackendRequests.clear()
        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
            this.endUserWait(request.id)
        }
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort'
        })
    }
}
