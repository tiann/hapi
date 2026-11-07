import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import type { PermissionMode } from '@hapi/protocol/types'
import { deriveToolInput, deriveToolName } from '@/agent/utils'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
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

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const request = this.pendingBackendRequests.get(response.id)
        this.pendingBackendRequests.delete(response.id)
        const decision = response.decision ?? (response.approved ? 'approved' : 'denied')

        if (decision === 'abort' && request) {
            await this.backend.cancelPrompt(request.sessionId)
        }
        if (request) {
            await this.backend.respondToPermission(request.sessionId, request, mapDecisionToOutcome(request, decision))
        }
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

    async cancelAll(reason: string): Promise<void> {
        const pending = Array.from(this.pendingBackendRequests.values())
        this.pendingBackendRequests.clear()
        for (const request of pending) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
        }
        this.cancelPendingRequests({
            completedReason: reason,
            rejectMessage: reason,
            decision: 'abort'
        })
    }
}
