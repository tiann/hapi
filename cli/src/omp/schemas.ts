/**
 * Zod schemas for OMP RPC protocol parsing.
 *
 * OMP shares Pi's protocol family, but its Model object carries thinking
 * info under `model.thinking.{efforts, effortMap, defaultLevel}` (a per-model
 * level list), not Pi's flat top-level `thinkingLevelMap`. get_state also
 * returns `sessionFile` (used for resume via switch_session).
 *
 * OMP 协议无版本保证 — 字段级容错策略：
 * 用 z.unknown().transform() / .catch() 确保非法类型字段静默丢弃，
 * 而非拒绝整个对象。
 */

import { z } from 'zod';
import { PI_THINKING_LEVELS } from '@hapi/protocol';
import type { OmpModelSummary } from '@hapi/protocol/apiTypes';

// ============================================================================
// 字段级容错 schema
// ============================================================================

/** 提取 string 值，非 string 或缺失返回 undefined */
const asOptStr = z.unknown().optional().transform(v => typeof v === 'string' ? v : undefined);

/** 提取并限制 string 长度，避免子进程事件把超大文本写入消息时间线 */
const asOptBoundedStr = (max: number) => z.unknown().optional().transform(v =>
    typeof v === 'string' ? v.slice(0, max) : undefined,
 );

/** 提取 string 值并限制长度，非法类型返回指定默认值 */
const asBoundedStrOrDef = (def: string, max: number) => z.unknown().optional().transform(v =>
    typeof v === 'string' ? v.slice(0, max) : def,
 );

/** 提取 number 值，非 number 或缺失返回 undefined */
const asOptNum = z.unknown().optional().transform(v => typeof v === 'number' ? v : undefined);

/** 提取有限非负数字，非法值返回指定默认值 */
const asNonNegativeNumOrDef = (def: number) => z.unknown().optional().transform(v =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def,
 );

/** 提取 boolean 值，非 boolean 或缺失返回 undefined */
const asOptBool = z.unknown().optional().transform(v => typeof v === 'boolean' ? v : undefined);

/** 提取 string 值，非 string 或缺失返回指定默认值 */
const asStrOrDef = (def: string) => z.unknown().optional().transform(v => typeof v === 'string' ? v : def);

/** 提取 string 数组，非法结构或缺失返回 undefined */
const asOptStrArray = z.unknown().optional().transform((v): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string');
    return arr.length > 0 ? arr : undefined;
});

/** 提取合法的 effortMap，非法结构或缺失返回 undefined */
const asOptEffortMap = z.unknown().optional().transform((v): Record<string, string | null> | undefined => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const map: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') map[key] = val;
        else if (val === null) map[key] = null;
    }
    return Object.keys(map).length > 0 ? map : undefined;
});

// ============================================================================
// OMP Agent Event (stdin JSONL → event)
// ============================================================================

/** Minimal shape: must be an object with a string `type` field. */
export const OmpAgentEventSchema = z.object({
    type: z.string(),
}).passthrough();

const SUBAGENT_LIFECYCLE_STATUSES = ['started', 'completed', 'failed', 'aborted'] as const;
const SUBAGENT_PROGRESS_STATUSES = ['pending', 'running', 'completed', 'failed', 'aborted'] as const;

/** Runtime validation for OMP's optional progress-level Subagent frames. */
export const OmpSubagentLifecycleEventSchema = z.object({
    type: z.literal('subagent_lifecycle'),
    payload: z.object({
        id: z.string().trim().min(1).max(256),
        agent: asBoundedStrOrDef('unknown', 256),
        agentSource: asOptBoundedStr(128),
        description: asOptBoundedStr(512),
        status: z.enum(SUBAGENT_LIFECYCLE_STATUSES),
        sessionFile: asOptBoundedStr(4096),
        parentToolCallId: asOptBoundedStr(256),
        index: asNonNegativeNumOrDef(0),
        detached: asOptBool,
    }).passthrough(),
}).passthrough();

const OmpSubagentRetryStateSchema = z.object({
    attempt: asNonNegativeNumOrDef(0),
    maxAttempts: asNonNegativeNumOrDef(0),
    delayMs: asNonNegativeNumOrDef(0),
    errorMessage: asOptBoundedStr(512),
}).passthrough().optional().catch(undefined);

const OmpSubagentRetryFailureSchema = z.object({
    attempt: asNonNegativeNumOrDef(0),
    errorMessage: asOptBoundedStr(512),
}).passthrough().optional().catch(undefined);

export const OmpSubagentProgressEventSchema = z.object({
    type: z.literal('subagent_progress'),
    payload: z.object({
        index: asNonNegativeNumOrDef(0),
        agent: asBoundedStrOrDef('unknown', 256),
        agentSource: asOptBoundedStr(128),
        task: asBoundedStrOrDef('', 8192),
        parentToolCallId: asOptBoundedStr(256),
        assignment: asOptBoundedStr(8192),
        sessionFile: asOptBoundedStr(4096),
        detached: asOptBool,
        progress: z.object({
            id: z.string().trim().min(1).max(256),
            status: z.enum(SUBAGENT_PROGRESS_STATUSES),
            description: asOptBoundedStr(512),
            lastIntent: asOptBoundedStr(512),
            currentTool: asOptBoundedStr(256),
            currentToolArgs: asOptBoundedStr(1024),
            toolCount: asNonNegativeNumOrDef(0),
            requests: asNonNegativeNumOrDef(0),
            tokens: asNonNegativeNumOrDef(0),
            durationMs: asNonNegativeNumOrDef(0),
            resolvedModel: asOptBoundedStr(256),
            retryState: OmpSubagentRetryStateSchema,
            retryFailure: OmpSubagentRetryFailureSchema,
        }).passthrough(),
    }).passthrough(),
}).passthrough();

export type ParsedOmpSubagentLifecycleEvent = z.infer<typeof OmpSubagentLifecycleEventSchema>;
export type ParsedOmpSubagentProgressEvent = z.infer<typeof OmpSubagentProgressEventSchema>;

// ============================================================================
// OMP Response Event (stdout response) — id-correlated
// ============================================================================

export const OmpResponseEventSchema = z.object({
    type: z.literal('response'),
    command: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    data: z.unknown().optional(),
    id: z.string().optional(),
});

// ============================================================================
// OMP Command Summary — source includes `builtin` (OMP pushes built-in
// slash commands like /model, /compact, /todo via available_commands_update)
// ============================================================================

const VALID_COMMAND_SOURCES = ['builtin', 'extension', 'skill', 'prompt', 'custom', 'mcp_prompt', 'file'] as const;
type OmpCommandSource = (typeof VALID_COMMAND_SOURCES)[number];

/** 单条 command 的容错 schema：非法字段静默修正，空 name 返回 null */
const OmpCommandEntrySchema = z.object({
    name: asStrOrDef(''),
    description: asOptStr,
    source: z.unknown().optional().transform(v =>
        VALID_COMMAND_SOURCES.includes(v as OmpCommandSource)
            ? (v as OmpCommandSource)
            : ('builtin' as const),
    ),
}).passthrough().transform((c) => {
    if (!c.name) return null;
    const entry: { name: string; description?: string; source: OmpCommandSource } = {
        name: c.name,
        source: c.source,
    };
    if (c.description !== undefined) entry.description = c.description;
    return entry;
});

const OmpCommandsResponseDataSchema = z.object({
    commands: z.array(z.unknown()).default([]),
}).transform(data =>
    data.commands
        .map(c => OmpCommandEntrySchema.safeParse(c))
        .filter((r): r is { success: true; data: NonNullable<typeof r.data> } => r.success && r.data !== null)
        .map(r => r.data),
);

// ============================================================================
// OMP Model Summary — thinking info under `model.thinking.*`
// ============================================================================

/** OMP model.thinking 子对象的容错提取 */
const OmpThinkingSchema = z.object({
    efforts: asOptStrArray,
    effortMap: asOptEffortMap,
    defaultLevel: asOptStr,
}).passthrough().optional().catch(undefined);

/** 单条 model 的容错 schema：非法字段静默丢弃，空 id 返回 null */
const OmpModelEntrySchema = z.object({
    id: asStrOrDef(''),
    provider: asStrOrDef('unknown'),
    name: asOptStr,
    contextWindow: asOptNum,
    reasoning: asOptBool,
    thinking: OmpThinkingSchema,
}).passthrough().transform((m): OmpModelSummary | null => {
    if (!m.id) return null;
    const entry: OmpModelSummary = { provider: m.provider, modelId: m.id };
    if (m.name !== undefined) entry.name = m.name;
    if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow;
    if (m.reasoning !== undefined) entry.reasoning = m.reasoning;
    if (m.thinking?.efforts !== undefined) entry.efforts = m.thinking.efforts;
    if (m.thinking?.effortMap !== undefined) entry.effortMap = m.thinking.effortMap;
    if (m.thinking?.defaultLevel !== undefined) entry.defaultLevel = m.thinking.defaultLevel;
    return entry;
});

const OmpModelsResponseDataSchema = z.object({
    models: z.array(z.unknown()).default([]),
}).transform(data =>
    data.models
        .map(m => OmpModelEntrySchema.safeParse(m))
        .filter((r): r is { success: true; data: NonNullable<typeof r.data> } => r.success && r.data !== null)
        .map(r => r.data),
);

// ============================================================================
// OMP State (get_state response data) — includes sessionFile for resume
// ============================================================================

export const OmpStateDataSchema = z.object({
    model: z.object({
        id: z.string().optional(),
        modelId: z.string().optional(),
        provider: z.string().optional(),
        thinking: OmpThinkingSchema,
    }).passthrough().optional().catch(undefined),
    sessionId: z.string().optional(),
    sessionFile: z.string().optional(),
    thinkingLevel: z.string().optional(),
    steeringMode: z.enum(['all', 'one-at-a-time']).optional().catch(undefined),
    followUpMode: z.enum(['all', 'one-at-a-time']).optional().catch(undefined),
    interruptMode: z.enum(['immediate', 'wait']).optional().catch(undefined),
}).passthrough();

// ============================================================================
// OMP set_model response data
// ============================================================================

export const OmpSetModelDataSchema = z.object({
    id: z.string().optional(),
    modelId: z.string().optional(),
    provider: z.string().optional(),
}).passthrough();

// ============================================================================
// SetSessionConfig RPC payload (same shape as Pi)
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
// OMP thinking level — enum sourced from @hapi/protocol (same Effort as Pi)
// ============================================================================

export const OmpThinkingLevelSchema = z.enum(PI_THINKING_LEVELS);

// ============================================================================
// message_update assistant message event — delta extraction (same as Pi)
// ============================================================================

export const OmpAssistantMessageEventSchema = z.object({
    type: z.string(),
    delta: z.string().optional(),
    contentIndex: z.number().optional(),
}).passthrough();

// ============================================================================
// Parse helpers
// ============================================================================

export function parseOmpCommands(data: unknown) {
    const result = OmpCommandsResponseDataSchema.safeParse(data);
    return result.success ? result.data : [];
}

export function parseOmpModels(data: unknown) {
    const result = OmpModelsResponseDataSchema.safeParse(data);
    return result.success ? result.data : [];
}
