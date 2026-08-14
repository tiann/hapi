import { z } from 'zod'

/**
 * HAPI's own typed protocol for DeepSeek Harness sessions.
 *
 * Everything in this file is DSH-shaped but DSH-package-free: it is the
 * allowlisted vocabulary the hub/web use to drive a DSH session through the
 * CLI, plus the durable views the CLI projects from native DSH events. The
 * CLI (`cli/src/dsh/`) is the only place that speaks the official DSH wire
 * contract; hub and web only ever see these schemas.
 */

// ---------------------------------------------------------------------------
// Session-scoped actions (allowlisted; no arbitrary method passthrough)
// ---------------------------------------------------------------------------

export const DshPromptRequestSchema = z.object({
    mode: z.enum(['queue', 'steer']),
    text: z.string().min(1).max(200_000)
})
export type DshPromptRequest = z.infer<typeof DshPromptRequestSchema>

export const DshInterruptRequestSchema = z.object({})
export type DshInterruptRequest = z.infer<typeof DshInterruptRequestSchema>

export const DshApprovalRespondRequestSchema = z.object({
    approvalId: z.string().min(1),
    /** The only two outcomes a DSH client may give. */
    outcome: z.enum(['allowed-once', 'rejected'])
})
export type DshApprovalRespondRequest = z.infer<typeof DshApprovalRespondRequestSchema>

export const DshQuestionAnswerItemSchema = z.object({
    id: z.string(),
    selected: z.array(z.string()).default([]),
    custom: z.string().optional()
})
export const DshQuestionAnswerSchema = z.object({
    answers: z.array(DshQuestionAnswerItemSchema)
})
export type DshQuestionAnswer = z.infer<typeof DshQuestionAnswerSchema>

export const DshQuestionRespondRequestSchema = z.object({
    /** The stable rpcId carried by the question/requested frame. */
    questionRpcId: z.string().min(1),
    answer: DshQuestionAnswerSchema
})
export type DshQuestionRespondRequest = z.infer<typeof DshQuestionRespondRequestSchema>

export const DshQueueActionRequestSchema = z.object({
    itemId: z.string().min(1),
    action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('edit'), text: z.string().min(1).max(200_000) }),
        z.object({ kind: z.literal('remove') }),
        z.object({ kind: z.literal('steer') })
    ])
})
export type DshQueueActionRequest = z.infer<typeof DshQueueActionRequestSchema>

export const DshSelectModelRequestSchema = z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().optional()
})
export type DshSelectModelRequest = z.infer<typeof DshSelectModelRequestSchema>

export const DshGoalRequestSchema = z.object({
    action: z.enum(['create', 'edit', 'pause', 'resume', 'complete', 'clear']),
    objective: z.string().max(20_000).optional(),
    maxGoalRounds: z.number().int().positive().optional(),
    refId: z.string().optional(),
    revision: z.number().int().nonnegative().optional()
}).superRefine((value, ctx) => {
    if (value.action === 'create' && !value.objective) {
        ctx.addIssue({ code: 'custom', message: 'goal.create requires objective' })
    }
    if (value.action !== 'create' && (value.refId === undefined || value.revision === undefined)) {
        ctx.addIssue({ code: 'custom', message: `goal.${value.action} requires refId and revision` })
    }
})
export type DshGoalRequest = z.infer<typeof DshGoalRequestSchema>

export const DshSubagentRequestSchema = z.object({
    action: z.enum(['list', 'history', 'prompt', 'interrupt']),
    childSessionId: z.string().min(1).optional(),
    mode: z.enum(['one-shot', 'continuable']).optional(),
    beforeSeq: z.number().int().nonnegative().optional(),
    maxMessages: z.number().int().positive().max(200).optional(),
    text: z.string().min(1).max(200_000).optional()
}).superRefine((value, ctx) => {
    if (value.action !== 'list' && !value.childSessionId) {
        ctx.addIssue({ code: 'custom', message: `subagent.${value.action} requires childSessionId` })
    }
    if (value.action === 'prompt' && !value.text) {
        ctx.addIssue({ code: 'custom', message: 'subagent.prompt requires text' })
    }
})
export type DshSubagentRequest = z.infer<typeof DshSubagentRequestSchema>

export const DshAgentPresetsRequestSchema = z.object({
    action: z.enum(['list', 'select']),
    agentPreset: z.string().min(1).optional()
}).superRefine((value, ctx) => {
    if (value.action === 'select' && !value.agentPreset) {
        ctx.addIssue({ code: 'custom', message: 'agentPresets.select requires agentPreset' })
    }
})
export type DshAgentPresetsRequest = z.infer<typeof DshAgentPresetsRequestSchema>

export const DshNativeHistoryRequestSchema = z.object({
    beforeSeq: z.number().int().nonnegative().optional(),
    maxMessages: z.number().int().positive().max(200).optional()
})
export type DshNativeHistoryRequest = z.infer<typeof DshNativeHistoryRequestSchema>

export const DshForkRequestSchema = z.object({
    atSeq: z.number().int().nonnegative().optional()
})
export type DshForkRequest = z.infer<typeof DshForkRequestSchema>

export const DshFeedbackRequestSchema = z.object({
    action: z.enum(['put', 'list', 'delete']),
    /** DSH native assistant-message id (carried on projected messages). */
    messageId: z.string().min(1).optional(),
    /** Official DSH rating vocabulary (positive/negative). */
    rating: z.enum(['positive', 'negative']).optional(),
    note: z.string().max(8_192).optional(),
    /** Observed item version for CAS; null requires absence. */
    ifVersion: z.string().nullable().optional()
}).superRefine((value, ctx) => {
    if (value.action === 'put' && (!value.messageId || !value.rating)) {
        ctx.addIssue({ code: 'custom', message: 'feedback.put requires messageId and rating' })
    }
    if (value.action === 'delete' && !value.messageId) {
        ctx.addIssue({ code: 'custom', message: 'feedback.delete requires messageId' })
    }
})
export type DshFeedbackRequest = z.infer<typeof DshFeedbackRequestSchema>

/** Discriminated allowlist of every session-scoped DSH action. */
export const DshActionSchema = z.discriminatedUnion('type', [
    DshPromptRequestSchema.extend({ type: z.literal('prompt') }),
    DshInterruptRequestSchema.extend({ type: z.literal('interrupt') }),
    DshApprovalRespondRequestSchema.extend({ type: z.literal('approval.respond') }),
    DshQuestionRespondRequestSchema.extend({ type: z.literal('question.respond') }),
    DshQueueActionRequestSchema.extend({ type: z.literal('queue.action') }),
    DshSelectModelRequestSchema.extend({ type: z.literal('model.select') }),
    DshGoalRequestSchema.extend({ type: z.literal('goal') }),
    DshSubagentRequestSchema.extend({ type: z.literal('subagent') }),
    DshAgentPresetsRequestSchema.extend({ type: z.literal('agentPresets') }),
    DshNativeHistoryRequestSchema.extend({ type: z.literal('nativeHistory') }),
    DshForkRequestSchema.extend({ type: z.literal('fork') }),
    DshFeedbackRequestSchema.extend({ type: z.literal('feedback') })
])
export type DshAction = z.infer<typeof DshActionSchema>

// ---------------------------------------------------------------------------
// Durable views projected from native DSH events (what the hub persists and
// the web folds into its DSH session store)
// ---------------------------------------------------------------------------

/** One non-chunk native event, persisted verbatim-shaped for replay fidelity. */
export const DshNativeEventSchema = z.object({
    seq: z.number().int().nonnegative(),
    type: z.string().min(1),
    time: z.number().int().nonnegative(),
    data: z.unknown(),
    /** The DSH session this event belongs to (root or subagent child). */
    dshSessionId: z.string().optional(),
    /** Surface identity when this event produced a message (fork anchors). */
    surfaceOp: z.union([z.literal('append'), z.object({ op: z.literal('replace'), start: z.number(), end: z.number() })]).optional(),
    sourceEventSeqs: z.array(z.number().int().nonnegative()).optional()
})
export type DshNativeEvent = z.infer<typeof DshNativeEventSchema>

/** Queue snapshot (session/queue frame) as persisted. */
export const DshQueueItemSchema = z.object({
    id: z.string(),
    placement: z.enum(['queued', 'steering', 'context']),
    /** First text block of the pending message, for rendering. */
    text: z.string(),
    /** Native message identity (ContentBlock[]) is retained on the CLI side. */
    hasImages: z.boolean().optional()
})
export type DshQueueItem = z.infer<typeof DshQueueItemSchema>
export const DshQueueSnapshotSchema = z.object({
    items: z.array(DshQueueItemSchema)
})
export type DshQueueSnapshot = z.infer<typeof DshQueueSnapshotSchema>

/** Background jobs snapshot (session/jobs frame) as persisted. */
export const DshJobViewSchema = z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    status: z.enum(['running', 'stopping', 'completed', 'killed', 'failed']),
    detail: z.string().optional(),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional()
})
export const DshJobsSnapshotSchema = z.object({
    jobs: z.array(DshJobViewSchema)
})
export type DshJobsSnapshot = z.infer<typeof DshJobsSnapshotSchema>

/** Goal projection as persisted (whole value from the 'goal' projection key). */
export const DshGoalStateSchema = z.object({
    id: z.string().optional(),
    objective: z.string().optional(),
    status: z.enum(['active', 'paused', 'complete', 'cleared']).optional(),
    maxGoalRounds: z.number().int().positive().optional(),
    currentRound: z.number().int().nonnegative().optional(),
    revision: z.number().int().nonnegative().optional()
})
export type DshGoalState = z.infer<typeof DshGoalStateSchema>

/** One pending user question (question/requested frame) as persisted. */
export const DshQuestionOptionSchema = z.object({
    label: z.string(),
    description: z.string().optional()
})
export const DshQuestionItemSchema = z.object({
    id: z.string(),
    question: z.string(),
    detail: z.string().optional(),
    header: z.string().optional(),
    options: z.array(DshQuestionOptionSchema).optional(),
    multiSelect: z.boolean().optional(),
    intent: z.object({ kind: z.literal('plan-review'), approve: z.string() }).optional()
})
export const DshPendingQuestionsSchema = z.object({
    questionRpcId: z.string(),
    items: z.array(DshQuestionItemSchema)
})
export type DshPendingQuestions = z.infer<typeof DshPendingQuestionsSchema>

/** One pending approval (approval/requested frame) as persisted. */
export const DshPendingApprovalSchema = z.object({
    approvalId: z.string(),
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional()
})
export type DshPendingApproval = z.infer<typeof DshPendingApprovalSchema>

/**
 * Whole DSH session state snapshot persisted as a `dsh_state` message. The
 * CLI emits the latest snapshot whenever a state-carrying frame arrives; the
 * web folds higher-seq snapshots into its per-session store.
 */
export const DshStateSnapshotSchema = z.object({
    seq: z.number().int().nonnegative(),
    queue: DshQueueSnapshotSchema.optional(),
    jobs: DshJobsSnapshotSchema.optional(),
    goal: DshGoalStateSchema.optional(),
    questions: DshPendingQuestionsSchema.optional(),
    approvals: z.array(DshPendingApprovalSchema).optional(),
    /** Current model selection (session.models().current). */
    model: z.object({
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string().optional()
    }).optional(),
    /** Session running status (host/session-status). */
    running: z.boolean().optional(),
    /** DSH-side session title (session/title projection). */
    title: z.string().optional()
})
export type DshStateSnapshot = z.infer<typeof DshStateSnapshotSchema>

// ---------------------------------------------------------------------------
// Views returned to the web through session-scoped RPCs
// ---------------------------------------------------------------------------

export const DshModelEffortOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional()
})
export const DshModelCatalogModelSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    efforts: z.array(DshModelEffortOptionSchema).optional(),
    defaultEffort: z.string().optional()
})
export const DshModelProviderGroupSchema = z.object({
    id: z.string(),
    name: z.string(),
    models: z.array(DshModelCatalogModelSchema)
})
export const DshModelsResponseSchema = z.object({
    current: z.object({
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string().optional()
    }),
    routable: z.boolean(),
    groups: z.array(DshModelProviderGroupSchema),
    failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() }))
})
export type DshModelsResponse = z.infer<typeof DshModelsResponseSchema>

export const DshSubagentEntrySchema = z.object({
    id: z.string(),
    kind: z.enum(['child', 'diagnostic']),
    mode: z.enum(['one-shot', 'continuable']).optional(),
    label: z.string().optional(),
    activity: z.enum(['running', 'inactive']).optional(),
    hasChildren: z.boolean().optional(),
    reason: z.enum(['corrupt', 'unsupported', 'unavailable']).optional()
})
export const DshSubagentCatalogSchema = z.object({
    entries: z.array(DshSubagentEntrySchema),
    parentAvailable: z.boolean()
})
export type DshSubagentCatalog = z.infer<typeof DshSubagentCatalogSchema>

export const DshPresetEntrySchema = z.object({
    id: z.string(),
    trust: z.enum(['system', 'user']),
    isDefault: z.boolean(),
    name: z.string().optional(),
    description: z.string().optional(),
    broken: z.string().optional()
})
export const DshAgentPresetsResponseSchema = z.object({
    presets: z.array(DshPresetEntrySchema),
    authorable: z.boolean(),
    hasDocument: z.boolean()
})
export type DshAgentPresetsResponse = z.infer<typeof DshAgentPresetsResponseSchema>

export const DshSkillEntrySchema = z.object({
    name: z.string(),
    description: z.string(),
    whenToUse: z.string().optional(),
    modelInvocable: z.boolean()
})
export const DshSkillsResponseSchema = z.object({
    skills: z.array(DshSkillEntrySchema)
})
export type DshSkillsResponse = z.infer<typeof DshSkillsResponseSchema>

/** Native history page (session.history / subagent.history) for deep-dive views. */
export const DshNativeHistoryResponseSchema = z.object({
    events: z.array(DshNativeEventSchema),
    hasMore: z.boolean()
})
export type DshNativeHistoryResponse = z.infer<typeof DshNativeHistoryResponseSchema>

export const DshForkResponseSchema = z.object({
    sessionId: z.string()
})
export type DshForkResponse = z.infer<typeof DshForkResponseSchema>

export const DshFeedbackItemSchema = z.object({
    messageId: z.string(),
    rating: z.enum(['positive', 'negative']).optional(),
    note: z.string().optional(),
    version: z.string()
})
export const DshFeedbackResponseSchema = z.object({
    items: z.array(DshFeedbackItemSchema)
})
export type DshFeedbackResponse = z.infer<typeof DshFeedbackResponseSchema>

/** Uniform success envelope for actions without a richer payload. */
export const DshAckResponseSchema = z.object({ accepted: z.literal(true) })
export type DshAckResponse = z.infer<typeof DshAckResponseSchema>

export const DshGoalResponseSchema = z.object({
    refId: z.string().optional(),
    revision: z.number().int().nonnegative().optional()
})
export type DshGoalResponse = z.infer<typeof DshGoalResponseSchema>

export const DshSelectModelResponseSchema = z.object({
    selected: z.object({
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string().optional()
    })
})
export type DshSelectModelResponse = z.infer<typeof DshSelectModelResponseSchema>
