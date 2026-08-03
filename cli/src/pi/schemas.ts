/**
 * Zod schemas for Pi RPC protocol parsing.
 *
 * All unknown→typed conversions happen here via Zod schemas,
 * so downstream code works with validated data only.
 *
 * Pi 协议无版本保证 — 字段级容错策略：
 * 用 z.unknown().transform() / .catch() 确保非法类型字段静默丢弃，
 * 而非拒绝整个对象。
 */

import { z } from 'zod';
import { PI_THINKING_LEVELS } from '@hapi/protocol';
import type { PiModelSummary } from '@hapi/protocol/apiTypes';
import type { PiContextUsage, PiExtensionUiRequest } from './types';

// ============================================================================
// 字段级容错 schema
// ============================================================================

/** 提取 string 值，非 string 或缺失返回 undefined */
const asOptStr = z.unknown().optional().transform(v => typeof v === 'string' ? v : undefined);

/** 提取 number 值，非 number 或缺失返回 undefined */
const asOptNum = z.unknown().optional().transform(v => typeof v === 'number' ? v : undefined);

/** Extract a finite positive number, otherwise return undefined. */
const asOptPositiveNum = z.unknown().optional().transform(v =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined,
);

/** Context usage tokens may be null immediately after compaction. */
const asContextTokens = z.unknown().optional().transform((v): number | null | undefined => {
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
});

/** 提取 boolean 值，非 boolean 或缺失返回 undefined */
const asOptBool = z.unknown().optional().transform(v => typeof v === 'boolean' ? v : undefined);

/** 提取 string 值，非 string 或缺失返回指定默认值 */
const asStrOrDef = (def: string) => z.unknown().optional().transform(v => typeof v === 'string' ? v : def);

/** 提取合法的 thinkingLevelMap，非法结构或缺失返回 undefined */
const asOptThinkingLevelMap = z.unknown().optional().transform((v): Record<string, string | null> | undefined => {
    if (typeof v !== 'object' || v === null) return undefined;
    const map: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') map[key] = val;
        else if (val === null) map[key] = null;
    }
    return Object.keys(map).length > 0 ? map : undefined;
});

// ============================================================================
// Pi Agent Event (stdin JSONL → event)
// ============================================================================

/** Minimal shape: must be an object with a string `type` field. */
export const PiAgentEventSchema = z.object({
    type: z.string(),
}).passthrough().transform((event) => {
    // Legacy Pi used auto_compaction_* for the same maintenance lifecycle that
    // current Pi calls compaction_*. Normalize while decoding stdout so every
    // downstream event consumer has one canonical protocol vocabulary.
    if (event.type === 'auto_compaction_start') {
        return {
            ...event,
            type: 'compaction_start',
            reason: event.reason === 'manual' || event.reason === 'threshold' || event.reason === 'overflow'
                ? event.reason
                : 'threshold',
        };
    }
    if (event.type === 'auto_compaction_end') {
        const { errorMessage: _legacyErrorMessage, ...rest } = event;
        return {
            ...rest,
            type: 'compaction_end',
            reason: event.reason === 'manual' || event.reason === 'threshold' || event.reason === 'overflow'
                ? event.reason
                : 'threshold',
            aborted: typeof event.aborted === 'boolean' ? event.aborted : false,
            willRetry: typeof event.willRetry === 'boolean' ? event.willRetry : false,
            ...(typeof event.errorMessage === 'string' ? { errorMessage: event.errorMessage } : {}),
        };
    }
    return event;
});

// ============================================================================
// Extension UI requests
// ============================================================================

const PiExtensionUiRequestBaseSchema = z.object({
    type: z.literal('extension_ui_request'),
    id: z.string().min(1),
});

export const PiExtensionUiRequestSchema = z.discriminatedUnion('method', [
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('select'),
        title: z.string(),
        options: z.array(z.string()),
        timeout: z.number().finite().nonnegative().optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('confirm'),
        title: z.string(),
        message: z.string(),
        timeout: z.number().finite().nonnegative().optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('input'),
        title: z.string(),
        placeholder: z.string().optional(),
        timeout: z.number().finite().nonnegative().optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('editor'),
        title: z.string(),
        prefill: z.string().optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('notify'),
        message: z.string(),
        notifyType: z.enum(['info', 'warning', 'error']).optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('setStatus'),
        statusKey: z.string(),
        statusText: z.string().optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('setWidget'),
        widgetKey: z.string(),
        widgetLines: z.array(z.string()).optional(),
        widgetPlacement: z.enum(['aboveEditor', 'belowEditor']).optional(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('setTitle'),
        title: z.string(),
    }),
    PiExtensionUiRequestBaseSchema.extend({
        method: z.literal('set_editor_text'),
        text: z.string(),
    }),
]) satisfies z.ZodType<PiExtensionUiRequest>;

const PiCompactionStartEventSchema = z.object({
    type: z.literal('compaction_start'),
    reason: z.enum(['manual', 'threshold', 'overflow']),
});

const PiCompactionEndEventSchema = z.object({
    type: z.literal('compaction_end'),
    reason: z.enum(['manual', 'threshold', 'overflow']),
    aborted: z.boolean(),
    willRetry: z.boolean(),
    errorMessage: z.string().optional(),
});

// Legacy Pi used the auto_compaction_* aliases. Their payloads are equivalent
// in practice, but accept omitted lifecycle detail from older extensions so
// the maintenance gate can still block a legacy agent_end settlement.
const PiLegacyAutoCompactionStartEventSchema = z.object({
    type: z.literal('auto_compaction_start'),
    reason: z.enum(['manual', 'threshold', 'overflow']).optional().default('threshold'),
}).passthrough().transform(({ type: _type, ...event }) => ({
    ...event,
    type: 'compaction_start' as const,
}));

const PiLegacyAutoCompactionEndEventSchema = z.object({
    type: z.literal('auto_compaction_end'),
    reason: z.enum(['manual', 'threshold', 'overflow']).optional().default('threshold'),
    aborted: z.boolean().optional().default(false),
    willRetry: z.boolean().optional().default(false),
    errorMessage: z.string().optional(),
}).passthrough().transform(({ type: _type, ...event }) => ({
    ...event,
    type: 'compaction_end' as const,
}));

const PiAutoRetryStartEventSchema = z.object({
    type: z.literal('auto_retry_start'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().finite().nonnegative(),
    errorMessage: z.string(),
});

const PiAutoRetryEndEventSchema = z.object({
    type: z.literal('auto_retry_end'),
    success: z.boolean(),
    attempt: z.number().int().positive(),
    finalError: z.string().optional(),
});

const PiSummarizationRetryScheduledEventSchema = z.object({
    type: z.literal('summarization_retry_scheduled'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().finite().nonnegative(),
    errorMessage: z.string(),
});

export const PiLifecycleEventSchema = z.union([
    PiCompactionStartEventSchema,
    PiCompactionEndEventSchema,
    PiLegacyAutoCompactionStartEventSchema,
    PiLegacyAutoCompactionEndEventSchema,
    PiAutoRetryStartEventSchema,
    PiAutoRetryEndEventSchema,
    PiSummarizationRetryScheduledEventSchema,
    z.object({ type: z.literal('summarization_retry_attempt_start'), source: z.enum(['branchSummary', 'compaction']) }).passthrough(),
    z.object({ type: z.literal('summarization_retry_finished') }),
]);

// ============================================================================
// Pi Response Event (stdout response)
// ============================================================================

export const PiResponseEventSchema = z.object({
    type: z.literal('response'),
    command: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    data: z.unknown().optional(),
    // RPC correlation id (sent by PiRpcResolver as string)
    id: z.string().optional(),
});

// ============================================================================
// Pi Command Summary
// ============================================================================

const VALID_COMMAND_SOURCES = ['extension', 'prompt', 'skill'] as const;
type PiCommandSource = (typeof VALID_COMMAND_SOURCES)[number];

const PiCommandSummarySchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(VALID_COMMAND_SOURCES),
});

/** 单条 command 的容错 schema：非法字段静默修正，空 name 返回 null */
const PiCommandEntrySchema = z.object({
    name: asStrOrDef(''),
    description: asOptStr,
    source: z.unknown().optional().transform(v =>
        VALID_COMMAND_SOURCES.includes(v as PiCommandSource)
            ? (v as PiCommandSource)
            : ('skill' as const),
    ),
}).passthrough().transform((c) => {
    if (!c.name) return null;
    const entry: { name: string; description?: string; source: PiCommandSource } = {
        name: c.name,
        source: c.source,
    };
    if (c.description !== undefined) entry.description = c.description;
    return entry;
});

const PiCommandsResponseDataSchema = z.object({
    commands: z.array(z.unknown()).default([]),
}).transform(data =>
    data.commands
        .map(c => PiCommandEntrySchema.safeParse(c))
        .filter((r): r is { success: true; data: NonNullable<typeof r.data> } => r.success && r.data !== null)
        .map(r => r.data),
);

// ============================================================================
// Pi Model Summary
// ============================================================================

/** 单条 model 的容错 schema：非法字段静默丢弃，空 id 返回 null */
const PiModelEntrySchema = z.object({
    id: asStrOrDef(''),
    provider: asStrOrDef('unknown'),
    name: asOptStr,
    contextWindow: asOptNum,
    reasoning: asOptBool,
    thinkingLevelMap: asOptThinkingLevelMap,
}).passthrough().transform((m): PiModelSummary | null => {
    if (!m.id) return null;
    const entry: PiModelSummary = { provider: m.provider, modelId: m.id };
    if (m.name !== undefined) entry.name = m.name;
    if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow;
    if (m.reasoning !== undefined) entry.reasoning = m.reasoning;
    if (m.thinkingLevelMap !== undefined) entry.thinkingLevelMap = m.thinkingLevelMap;
    return entry;
});

const PiModelsResponseDataSchema = z.object({
    models: z.array(z.unknown()).default([]),
}).transform(data =>
    data.models
        .map(m => PiModelEntrySchema.safeParse(m))
        .filter((r): r is { success: true; data: NonNullable<typeof r.data> } => r.success && r.data !== null)
        .map(r => r.data),
);

const PiSessionStatsDataSchema = z.object({
    contextUsage: z.object({
        tokens: asContextTokens,
        contextWindow: asOptPositiveNum,
    }).passthrough().optional(),
}).passthrough();

// ============================================================================
// Pi State (get_state response data)
// ============================================================================

export const PiStateDataSchema = z.object({
    model: z.object({
        id: z.string().optional(),
        modelId: z.string().optional(),
        provider: z.string().optional(),
    }).passthrough().optional(),
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    thinkingLevel: z.string().optional(),
    steeringMode: z.enum(['all', 'one-at-a-time']).optional(),
    isStreaming: z.boolean().optional(),
}).passthrough();

// ============================================================================
// Pi set_model response data
// ============================================================================

export const PiSetModelDataSchema = z.object({
    id: z.string().optional(),
    modelId: z.string().optional(),
    provider: z.string().optional(),
}).passthrough();

// ============================================================================
// SetSessionConfig RPC payload
// ============================================================================

export const SetSessionConfigPayloadSchema = z.object({
    permissionMode: z.unknown().optional(),
    model: z.union([
        z.string(),
        z.object({ provider: z.string(), modelId: z.string() }),
        z.null(),
    ]).optional(),
    effort: z.unknown().optional(),
}).passthrough();

// ============================================================================
// Pi thinking level — enum sourced from @hapi/protocol (single definition)
// ============================================================================

export const PiThinkingLevelSchema = z.enum(PI_THINKING_LEVELS);

// ============================================================================
// message_update assistant message event — delta extraction
// ============================================================================

export const PiAssistantMessageEventSchema = z.object({
    type: z.string(),
    delta: z.string().optional(),
    contentIndex: z.number().optional(),
}).passthrough();

export const PiToolExecutionStartEventSchema = z.object({
    type: z.literal('tool_execution_start'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
});

export const PiToolExecutionUpdateEventSchema = z.object({
    type: z.literal('tool_execution_update'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
    partialResult: z.unknown(),
});

export const PiToolExecutionEndEventSchema = z.object({
    type: z.literal('tool_execution_end'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    result: z.unknown(),
    isError: z.boolean(),
});

export const PiAgentEndEventSchema = z.object({
    type: z.literal('agent_end'),
    willRetry: z.boolean().optional(),
}).passthrough();

export const PiAgentSettledEventSchema = z.object({
    type: z.literal('agent_settled'),
});

// ============================================================================
// Parse helpers — replace hand-written type guards in loop.ts
// ============================================================================

export function parsePiCommands(data: unknown) {
    const result = PiCommandsResponseDataSchema.safeParse(data)
    return result.success ? result.data : []
}

export function parsePiModels(data: unknown) {
    const result = PiModelsResponseDataSchema.safeParse(data)
    return result.success ? result.data : []
}

/**
 * Parse Pi's authoritative current context-window estimate.
 *
 * undefined: stats unavailable/malformed; callers may fall back to turn usage.
 * null: Pi explicitly reports unknown (for example, immediately after compaction).
 */
export function parsePiContextUsage(data: unknown): PiContextUsage | null | undefined {
    const result = PiSessionStatsDataSchema.safeParse(data);
    if (!result.success || !result.data.contextUsage) return undefined;

    const { tokens, contextWindow } = result.data.contextUsage;
    if (tokens === null) return null;
    if (tokens === undefined) return undefined;

    return contextWindow === undefined ? { tokens } : { tokens, contextWindow };
}
