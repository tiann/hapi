import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types'
import { deriveToolName } from '@/agent/utils'
import { asString, isObject } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import {
    BasePermissionHandler,
    type PendingPermissionRequest,
    type PermissionCompletion
} from '@/modules/common/permission/BasePermissionHandler'

interface PermissionResponseMessage {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    optionId?: string
    reason?: string
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>
}

type PermissionDecision = NonNullable<PermissionResponseMessage['decision']>

type ReasonixQuestion = {
    id: string
    question: string
    options: Array<{ label: string; description: string | null }>
    multiSelect: boolean
}

type NormalizedQuestion = {
    question: ReasonixQuestion
    input: { questions: Array<{
        id: string
        header: string | null
        question: string
        options: Array<{ id: string; label: string; description: string | null }>
        multiSelect: boolean
    }> }
}

function inputOf(request: PermissionRequest): unknown {
    return request.rawInput !== undefined ? request.rawInput : request.rawOutput
}

function normalizeQuestion(request: PermissionRequest): NormalizedQuestion | null {
    // Reasonix's `ask` tool rides session/request_permission with kind=other
    // and a compact `{id, question, options, multi}` rawInput payload. Restrict
    // the conversion to that shape so ordinary tools containing an `options`
    // argument remain ordinary permission cards.
    // Reasonix's structured question requests use `ask-...` tool ids. Keep
    // ordinary `kind=other` tool permissions on the regular approval card,
    // even when their input happens to contain question/options fields.
    const isReasonixAsk = request.toolCallId.startsWith('ask-') || request.id.startsWith('ask-')
    if (!isReasonixAsk || request.kind !== 'other' || !isObject(request.rawInput)) return null
    const questionText = asString(request.rawInput.question)?.trim()
    const rawOptions = Array.isArray(request.rawInput.options) ? request.rawInput.options : []
    if (!questionText || rawOptions.length === 0) return null

    const questionId = asString(request.rawInput.id)?.trim() || request.id
    const allowOptions = request.options.filter((candidate) => (
        candidate.kind === 'allow_once' || candidate.kind === 'allow_always'
    ))
    const options = rawOptions.map((raw, index) => {
        const record = isObject(raw) ? raw : {}
        const fallback = allowOptions[index]
        return {
            id: fallback?.optionId ?? `${questionId}:${index + 1}`,
            label: asString(record.label)?.trim() || fallback?.name || `Option ${index + 1}`,
            description: asString(record.description)?.trim() || null
        }
    })
    const question: ReasonixQuestion = {
        id: questionId,
        question: questionText,
        options: options.map(({ label, description }) => ({ label, description })),
        // ACP's Reasonix requestAskQuestion response carries one selected
        // option per question even when the source event marks the prompt as
        // multi-select. Expose the wire-supported single-choice contract to
        // HAPI rather than rendering choices that cannot be returned.
        multiSelect: false
    }

    return {
        question,
        input: {
            questions: [{
                id: questionId,
                header: null,
                question: questionText,
                options,
                multiSelect: question.multiSelect
            }]
        }
    }
}

function answerValues(
    answers: PermissionResponseMessage['answers']
): string[] {
    if (!answers) return []
    const values: string[] = []
    for (const value of Object.values(answers)) {
        if (Array.isArray(value)) {
            values.push(...value.filter((entry): entry is string => typeof entry === 'string'))
        }
        else if (isObject(value) && Array.isArray(value.answers)) {
            values.push(...value.answers.filter((entry): entry is string => typeof entry === 'string'))
        }
    }
    return values.map((value) => value.trim()).filter((value) => value.length > 0)
}

function resolvePermissionDecision(response: PermissionResponseMessage): {
    decision: PermissionDecision
    consistent: boolean
} {
    if (typeof response.approved !== 'boolean') {
        return { decision: 'abort', consistent: false }
    }

    const decision = response.decision ?? (response.approved ? 'approved' : 'denied')
    const consistent = response.approved
        ? decision === 'approved' || decision === 'approved_for_session'
        : decision === 'denied' || decision === 'abort'
    return { decision, consistent }
}

function isAcceptedQuestionOption(
    candidate: PermissionRequest['options'][number],
    decision: PermissionResponseMessage['decision']
): boolean {
    const expectedKind = decision === 'approved_for_session' ? 'allow_always' : 'allow_once'
    return candidate.kind === expectedKind
}

function questionOutcome(
    request: PermissionRequest,
    question: NormalizedQuestion | null,
    response: PermissionResponseMessage,
    decision: PermissionResponseMessage['decision']
): PermissionResponse {
    const reject = option(request, ['reject_once', 'reject_always'], { fallbackToFirst: false })
    if (decision === 'abort') return { outcome: 'cancelled' }
    if (response.optionId) {
        const acceptedKinds = decision === 'denied'
            ? new Set(['reject_once'])
            : decision === 'approved_for_session'
                ? new Set(['allow_always'])
                : new Set(['allow_once'])
        const selected = request.options.find((candidate) => (
            candidate.optionId === response.optionId && acceptedKinds.has(candidate.kind)
        ))
        return selected
            ? { outcome: 'selected', optionId: selected.optionId }
            : { outcome: 'cancelled' }
    }
    if (!question || decision === 'denied' || response.approved === false) {
        return reject ? { outcome: 'selected', optionId: reject } : { outcome: 'cancelled' }
    }

    const selected = answerValues(response.answers)
    const uiOptions = question.input.questions[0]?.options ?? []
    const answerOptions = request.options.filter((candidate) => (
        candidate.kind === 'allow_once' || candidate.kind === 'allow_always'
    ))
    for (const value of selected) {
        const uiIndex = uiOptions.findIndex((candidate) => candidate.id === value || candidate.label === value)
        // Keep the UI index mapping stable, then enforce the decision's scope.
        // Filtering by kind before indexing would let a forged response select
        // a different visible option after the list is compressed.
        const indexedMatch = uiIndex >= 0
            ? answerOptions[uiIndex]
            : undefined
        const match = uiIndex >= 0
            ? indexedMatch && isAcceptedQuestionOption(indexedMatch, decision)
                ? indexedMatch
                : undefined
            : request.options.find((candidate) => (
                isAcceptedQuestionOption(candidate, decision)
                && (candidate.optionId === value || candidate.name === value)
            ))
        if (match) return { outcome: 'selected', optionId: match.optionId }
    }

    // A question has no meaningful generic "allow" operation. Cancelling is
    // safer than silently choosing the first answer when an older UI omits the
    // structured `answers` payload.
    return reject ? { outcome: 'selected', optionId: reject } : { outcome: 'cancelled' }
}

function option(
    request: PermissionRequest,
    kinds: string[],
    options: { fallbackToFirst?: boolean } = {}
): string | null {
    for (const kind of kinds) {
        const found = request.options.find((candidate) => candidate.kind === kind)
        if (found) return found.optionId
    }
    if (options.fallbackToFirst === false) return null
    return request.options[0]?.optionId ?? null
}

function outcome(
    request: PermissionRequest,
    decision: PermissionResponseMessage['decision'],
    optionId?: string
): PermissionResponse {
    if (decision === 'abort') return { outcome: 'cancelled' }
    const expectedKind = decision === 'approved_for_session'
        ? 'allow_always'
        : decision === 'approved'
            ? 'allow_once'
            : 'reject_once'
    if (optionId) {
        return request.options.some((candidate) => (
            candidate.optionId === optionId && candidate.kind === expectedKind
        ))
            ? { outcome: 'selected', optionId }
            : { outcome: 'cancelled' }
    }
    const id = option(request, [expectedKind], { fallbackToFirst: false })
    return id ? { outcome: 'selected', optionId: id } : { outcome: 'cancelled' }
}

export class ReasonixPermissionHandler extends BasePermissionHandler<PermissionResponseMessage, void> {
    private readonly pendingBackend = new Map<string, PermissionRequest>()

    constructor(
        session: ApiSessionClient,
        private readonly backend: AgentBackend
    ) {
        super(session)
        backend.onPermissionRequest((request) => this.handleRequest(request))
    }

    private handleRequest(request: PermissionRequest): void {
        const question = normalizeQuestion(request)
        const tool = question
            ? 'AskUserQuestion'
            : deriveToolName({ title: request.title, kind: request.kind, rawInput: request.rawInput })
        const input = question?.input ?? inputOf(request)
        // Reasonix applies Ask/Auto/Yolo and Plan policy inside its own
        // controller. A request that reaches ACP is therefore an explicit
        // ask, deny, plan-confirmation, or fresh-approval boundary; answering
        // it blindly here would bypass the native policy. Keep every request
        // visible to HAPI, regardless of the selected mode.
        this.pendingBackend.set(request.id, request)
        this.addPendingRequest(
            request.id,
            tool,
            input,
            { resolve: () => {}, reject: () => {} },
            { permissionOptions: request.options }
        )
        logger.debug(`[Reasonix] Permission request queued for ${tool} (${request.id})`)
    }

    protected async handlePermissionResponse(
        response: PermissionResponseMessage,
        pending: PendingPermissionRequest<void>
    ): Promise<PermissionCompletion> {
        const request = this.pendingBackend.get(response.id)
        this.pendingBackend.delete(response.id)
        const { decision, consistent } = resolvePermissionDecision(response)
        const question = request ? normalizeQuestion(request) : null
        const permissionResponse = request
            ? !consistent
                ? { outcome: 'cancelled' as const }
                : question
                    ? questionOutcome(request, question, response, decision)
                    : outcome(request, decision, response.optionId)
            : null
        if (request) {
            if (decision === 'abort') await this.backend.cancelPrompt(request.sessionId)
            await this.backend.respondToPermission(request.sessionId, request, permissionResponse!)
        }
        pending.resolve()
        const canceled = permissionResponse?.outcome === 'cancelled'
        const selectedOption = request && permissionResponse?.outcome === 'selected'
            ? request.options.find((candidate) => candidate.optionId === permissionResponse.optionId)
            : undefined
        const rejectedByOption = selectedOption?.kind === 'reject_once'
            || selectedOption?.kind === 'reject_always'
        const questionMissingAnswer = Boolean(
            consistent
            && question
            && !response.optionId
            && (decision === 'approved' || decision === 'approved_for_session')
            && answerValues(response.answers).length === 0
        )
        const approved = !canceled
            && !questionMissingAnswer
            && (decision === 'approved' || decision === 'approved_for_session' || response.approved === true)
        return {
            status: canceled || questionMissingAnswer || decision === 'abort'
                ? 'canceled'
                : rejectedByOption ? 'denied' : approved ? 'approved' : 'denied',
            decision: canceled || questionMissingAnswer
                ? 'abort'
                : rejectedByOption ? 'denied' : decision,
            reason: response.reason,
            answers: response.answers
        }
    }

    protected handleMissingPendingResponse(response: PermissionResponseMessage): void {
        logger.debug('[Reasonix] Permission response received for unknown request', response.id)
    }

    async cancelAll(reason: string): Promise<void> {
        for (const request of this.pendingBackend.values()) {
            await this.backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' })
        }
        this.pendingBackend.clear()
        this.cancelPendingRequests({ completedReason: reason, rejectMessage: reason, decision: 'abort' })
    }
}
