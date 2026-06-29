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

/** 提取 string 值，非 string 返回 undefined */
const asOptStr = z.unknown().transform(v => typeof v === 'string' ? v : undefined);

/** 提取 number 值，非 number 返回 undefined */
const asOptNum = z.unknown().transform(v => typeof v === 'number' ? v : undefined);

/** 提取 boolean 值，非 boolean 返回 undefined */
const asOptBool = z.unknown().transform(v => typeof v === 'boolean' ? v : undefined);

/** 提取 string 值，非 string 返回指定默认值 */
const asStrOrDef = (def: string) => z.unknown().transform(v => typeof v === 'string' ? v : def);

/** 提取 string 数组，非法结构返回 undefined */
const asOptStrArray = z.unknown().transform((v): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string');
    return arr.length > 0 ? arr : undefined;
});

/** 提取合法的 effortMap，非法结构返回 undefined */
const asOptEffortMap = z.unknown().transform((v): Record<string, string | null> | undefined => {
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
    source: z.unknown().transform(v =>
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
    return OmpCommandsResponseDataSchema.safeParse(data).data ?? [];
}

export function parseOmpModels(data: unknown) {
    return OmpModelsResponseDataSchema.safeParse(data).data ?? [];
}
