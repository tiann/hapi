import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
    extractTargetFilePaths,
    isDisplayOrReadFileTool,
    type AutoApprovalDecision,
    type AutoApprovalRuleSet,
    type PendingPermissionRequest,
    type PermissionCompletion
} from './BasePermissionHandler'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    reason?: string
    answers?: Record<string, string[]>
}

export type UserAnswer = {
    decision: NonNullable<PermissionResponseMessage['decision']>
    answers?: Record<string, string[]>
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
        let toolInput = deriveToolInput(request)
        if (!toolInput && (request.kind === 'read' || isDisplayOrReadFileTool(request.title, request.kind))) {
            const derivedPaths = extractTargetFilePaths(null, request.title, request.kind)
            if (derivedPaths.length > 0) {
                toolInput = { file_path: derivedPaths[0] }
            }
        }
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
        })
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

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const question = this.userQuestions.get(response.id)
        if (question) {
            this.userQuestions.delete(response.id)
            const decision = response.decision ?? (response.approved ? 'approved' : 'denied')
            this.endUserWait(response.id)
            question(response.answers ? { decision, answers: response.answers } : { decision })
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
            await this.backend.cancelPrompt(request.sessionId)
        }
        if (request) {
            if (!response.approved || decision === 'denied' || decision === 'abort') {
                const targetPaths = extractTargetFilePaths(request.rawInput, request.title, request.kind)
                for (const targetPath of targetPaths) {
                    this.client.markAttachmentDenied?.(targetPath)
                }
            }
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
        return this.pendingBackendRequests.size > 0 || this.userQuestions.size > 0
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
            const targetPaths = extractTargetFilePaths(request.rawInput, request.title, request.kind)
            for (const targetPath of targetPaths) {
                this.client.markAttachmentDenied?.(targetPath)
            }
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
