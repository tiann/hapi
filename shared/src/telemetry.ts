import { z } from 'zod'

/**
 * hapi 遥测统一契约(web SDK ⇄ hub ingest 双端同源)。
 *
 * 设计真相源:《文档/技术调研/hapi日志观测研究-2026-11-20.md》§4(事件 schema)与 §3.4(裁决)。
 * 管线:web 端 fail-silent SDK 批量 POST /api/telemetry/events(keepalive fetch 唯一通道,
 * sendBeacon 连兜底也否——无法带 Authorization header,token-in-query 会落 openresty/CF 日志,
 * 踩脱敏红线);hub 单事务拆入泛型 telemetry_events(ux+diag)与窄列 perf_* 表。
 *
 * ★visit 语义(PWA 长后台 = 移动端主形态,定死):
 *   - hidden ≤ 15min:同一 visit,由 session_pause_resume(hidden≤15min 的切分)在 visit 内分段;
 *   - hidden > 15min:SDK 触发 session_close(exit='hidden-timeout'),此后 visibilitychange→visible
 *     且 SessionPage 仍 mounted(无导航、会话未切换)时,补发 synthetic session_open
 *     (entry='resume-after-timeout'),dwell 从返回时刻重新起算 = 新 visit。
 *     不补发则该段停留既无 open 也无 close,『停留多久后退出』在移动端系统性缺一截。
 *   - 口径闭环测试:后台 16min→前台,期望恰 1 条 close(hidden-timeout)+ 1 条 open
 *     (resume-after-timeout);新 visit wallDwellMs 不含后台段、visibleDwellMs 只计前台。
 *
 * ★脱敏红线:cliApiToken/JWT/密码/AK·SK 绝不进任何遥测字段;URL query 整串剥弃
 * (normalizeApiPath;useSSE 把 token 放 query 是一等红线);对话正文/标题/搜索词零接触
 * (schema 层不存在该字段);messageHead/warningText/slowestJson/stackTop 四类字段过
 * sanitizeTelemetryText 统一正则网(Bearer/sk-/eyJ/token=),zod 侧 transform 二道网。
 */

// ---------------------------------------------------------------------------
// 常量(与 bodyLimit / 队列配额成对出现)
// ---------------------------------------------------------------------------

/** 单批事件数帽(信封 zod 与端点校验同源)。 */
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 64
/** 单事件 data JSON 字节帽。 */
export const TELEMETRY_MAX_EVENT_DATA_BYTES = 4 * 1024
/** POST /api/telemetry/events 的 hono bodyLimit(workGraph.ts:17 先例)。 */
export const TELEMETRY_BODY_LIMIT_BYTES = 256 * 1024
/** messageHead/warningText 等人读摘要字段帽(脱敏+截断后)。 */
export const TELEMETRY_MAX_MESSAGE_HEAD = 200
/** fingerprint 帽。 */
export const TELEMETRY_MAX_FINGERPRINT = 120
/** 入参字符串在脱敏/截断前的宽松帽(防恶意超大字段先耗 CPU)。 */
export const TELEMETRY_MAX_TEXT_FIELD = 1024

/** SDK 上报自带此头;hub perfTimingMiddleware 与 web fetch 包装双向豁免(防自激环)。 */
export const TELEMETRY_SELF_HEADER = 'x-hapi-telemetry'
/** web 生成、hub 回声;双平面配对键("网络慢 vs 服务慢"拆分器)。 */
export const TELEMETRY_TRACE_HEADER = 'x-hapi-trace-id'

/** 等级:0 关 / 1 元数据(默认)/ 2 详细+采样 / 3 全量调试(自动 24h 回落)。 */
export type TelemetryLevel = 0 | 1 | 2 | 3

export type TelemetryDomain = 'ux' | 'diag' | 'perf'
export type TelemetryDeviceKind = 'browser' | 'pwa' | 'berry' | 'telegram'
export type TelemetryOriginKind = 'direct' | 'cf-orange' | 'local'

// ---------------------------------------------------------------------------
// 脱敏正则网(zod 白名单是第一道,这是第二道;两道都在 hub ingest 生效)
// ---------------------------------------------------------------------------

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [redacted]'],
    [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]'],
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]{4,}/g, '[redacted-jwt]'],
    [/eyJ[A-Za-z0-9._-]{16,}/g, '[redacted-jwt]'],
    [/([?&;\s"'_]token=)[^&\s"']+/gi, '$1[redacted]'],
]

/** 先脱敏后截断(截断已脱敏串不会重新暴露凭据)。 */
export function sanitizeTelemetryText(input: string, maxLen: number = TELEMETRY_MAX_MESSAGE_HEAD): string {
    let s = input
    for (const [re, replacement] of REDACTIONS) s = s.replace(re, replacement)
    return s.length > maxLen ? s.slice(0, maxLen) : s
}

// ---------------------------------------------------------------------------
// 路径归一化:web 行与 hub 行 path_tpl 逐字节一致(可 JOIN)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i
const LONG_NUM_RE = /^\d{4,}$/

/**
 * 剥 query 整串(★token 在 query 是一等红线,如 useSSE 的订阅 URL)、uuid/长 hex/长数字段
 * 折叠为 `:id`。method 参数保留以钉死双端调用签名一致性;path_tpl 不含 method(独立列)。
 */
export function normalizeApiPath(_method: string, path: string): string {
    const noQuery = path.split('?')[0]!.split('#')[0]!
    const segments = noQuery.split('/').map((seg) => {
        if (seg === '') return seg
        if (UUID_RE.test(seg) || LONG_HEX_RE.test(seg) || LONG_NUM_RE.test(seg)) return ':id'
        return seg
    })
    let tpl = segments.join('/')
    if (tpl.length > 1 && tpl.endsWith('/')) tpl = tpl.slice(0, -1)
    return tpl.slice(0, 256)
}

// ---------------------------------------------------------------------------
// 指纹(djb2;客户端计算,服务端只存)
// ---------------------------------------------------------------------------

export function telemetryFingerprint(name: string, detail: string = ''): string {
    const s = `${name}|${detail}`
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return `${name.slice(0, 64)}:${(h >>> 0).toString(16)}`.slice(0, TELEMETRY_MAX_FINGERPRINT)
}

// ---------------------------------------------------------------------------
// zod 基件
// ---------------------------------------------------------------------------

const intMs = z.number().int().min(0)
const shortStr = (n: number) => z.string().max(n)
/** 二道脱敏网:transform 后输出已过 sanitizeTelemetryText(即使客户端漏脱也拦得住)。 */
const sanitizedField = (max: number) =>
    z
        .string()
        .max(TELEMETRY_MAX_TEXT_FIELD)
        .transform((s) => sanitizeTelemetryText(s, max))

// ---------------------------------------------------------------------------
// 事件 kind 注册表(域 / 最低采集等级 / data 白名单 schema)
// ---------------------------------------------------------------------------

export interface TelemetryKindSpec {
    domain: TelemetryDomain
    /** 采该事件所需的最低 telemetryLevel(服务端丢弃 minLevel > 配置级的事件)。 */
    minLevel: 1 | 2 | 3
    data: z.ZodTypeAny
}

const SESSION_OPEN_DATA = z.object({
    entry: z.enum(['list-click', 'search-hit', 'permission-jump', 'deep-link', 'url-direct', 'resume-after-timeout']),
    openedAt: intMs,
    fromSessionId: shortStr(128).optional(),
    navTargetMessageId: shortStr(128).optional(),
})

const SESSION_CLOSE_DATA = z.object({
    wallDwellMs: intMs,
    visibleDwellMs: intMs,
    exit: z.enum(['switch', 'navigate-away', 'pagehide', 'hidden-timeout']),
    seenTail: z.boolean().optional(),
    closeCause: shortStr(64).optional(),
})

const DATA_LOADED_DATA = z.object({
    cacheHitOnActivate: z.boolean(),
    messageCountAfterSync: z.number().int().min(0),
    settledAt: intMs.optional(),
})

const WINDOW_ENTRY = z.object({
    messageCount: z.number().int().min(0),
    approxBytes: z.number().int().min(0),
    persisted: z.boolean(),
    active: z.boolean(),
})

const CLIENT_WINDOW_INVENTORY_DATA = z.object({
    sessionsHeld: z.number().int().min(0),
    storageUsedBytes: z.number().int().min(0),
    windows: z.array(WINDOW_ENTRY).max(128),
})

const SESSION_PAUSE_RESUME_DATA = z.object({
    kind: z.enum(['pause', 'resume']),
    dwellSoFarMs: intMs,
})

const SESSION_PIN_DATA = z.object({
    mode: z.enum(['none', 'project', 'global']),
})

const SESSION_SWITCH_DATA = z.object({
    at: intMs,
})

const JS_ERROR_DATA = z.object({
    name: shortStr(128),
    messageHead: sanitizedField(TELEMETRY_MAX_MESSAGE_HEAD),
    source: shortStr(256).optional(),
    line: z.number().int().min(0).optional(),
    col: z.number().int().min(0).optional(),
    /** ≤3 帧,只记帧地址,统一脱敏网兜底。 */
    stackTop: z.array(sanitizedField(200)).max(3).optional(),
})

const PROMISE_REJECTION_DATA = z.object({
    name: shortStr(128),
    messageHead: sanitizedField(TELEMETRY_MAX_MESSAGE_HEAD),
})

const RENDER_ERROR_DATA = z.object({
    boundary: shortStr(128),
    fatal: z.boolean(),
    name: shortStr(128).optional(),
    messageHead: sanitizedField(TELEMETRY_MAX_MESSAGE_HEAD).optional(),
    componentStackTop: sanitizedField(200).optional(),
})

const SSE_ANOMALY_DATA = z.object({
    anomaly: z.enum(['disconnect', 'gap', 'stall', 'reconnect-storm']),
    /** web 内部重连原因码(开放小词表,≤32)。 */
    reason: shortStr(32).optional(),
    outageMs: intMs.optional(),
    resumedAfterGap: z.boolean().optional(),
    hiddenAtDrop: z.boolean().optional(),
    /** stall 判定 predicate:仅回合进行期(agent thinking/working)且无 message-received > Ns;
     * N 初值 30s,首周实数据校准。无条件『连接无事件』不判定(长工具调用是正常静默)。 */
    stallMs: intMs.optional(),
})

const LOAD_INCOMPLETE_DATA = z.object({
    signal: z.enum(['tail-warning', 'gap-recovery', 'empty-window']),
    /** 上游是 error.message(可拼响应 body 整串)——必过统一脱敏网。 */
    warningText: sanitizedField(TELEMETRY_MAX_MESSAGE_HEAD).optional(),
})

const LOAD_SLOW_DATA = z.object({
    phase: z.enum(['session-detail', 'tail-sync']),
    durationMs: intMs,
    fromCache: z.boolean(),
})

const SEND_STALL_DATA = z.object({
    /** 看门狗阈值常量(useSendMessage SEND_WATCHDOG_MS=10_000)。 */
    pendingMs: intMs,
    outcome: z.enum(['timeout-marked', 'late-success', 'late-error']),
})

const TURN_LATENCY_DATA = z.object({
    /** send POST 落定 → 该会话下一条 agent 侧 message-received =『发送静默』核心分布。 */
    firstAgentMs: intMs.optional(),
    turnTotalMs: intMs.optional(),
    firstEventKind: shortStr(64).optional(),
    outcome: z.enum(['completed', 'aborted']),
})

const HANDLED_ERROR_DATA = z.object({
    name: shortStr(128),
    messageHead: sanitizedField(TELEMETRY_MAX_MESSAGE_HEAD),
})

const HTTP_SAMPLE_DATA = z.object({
    method: shortStr(8),
    pathTpl: shortStr(256),
    /** 0 = 网络层失败(web 行)。 */
    status: z.number().int().min(0),
    ttfbMs: intMs.optional(),
    totalMs: intMs,
    reqBytes: z.number().int().min(0).optional(),
    resBytes: z.number().int().min(0).optional(),
    resBytesSource: z.enum(['content-length', 'decoded']).optional(),
    cacheHit: z.boolean().optional(),
    traceId: shortStr(64).optional(),
    /** ux 交互归因列(session-open|send|prefetch|…;窗外为 NULL)。 */
    trigger: shortStr(32).optional(),
    attempt: z.number().int().min(0).optional(),
    phase: z.enum(['network', 'http', 'parse']).optional(),
    code: shortStr(64).optional(),
    originKind: shortStr(16).optional(),
})

const SSE_EPISODE_DATA = z.object({
    subscriptionId: shortStr(64).optional(),
    scope: shortStr(32).optional(),
    resume: z.enum(['ok', 'gap']).optional(),
    connectMs: intMs.optional(),
    durationMs: intMs,
    eventsCount: z.number().int().min(0),
    bytesSent: z.number().int().min(0).optional(),
    gapMs: intMs.optional(),
    disconnectReason: shortStr(32).optional(),
})

const WEB_VITAL_DATA = z.object({
    lcpMs: intMs.optional(),
    inpP75Ms: intMs.optional(),
    inpMaxMs: intMs.optional(),
    interactions: z.number().int().min(0).optional(),
    cls: z.number().min(0).optional(),
    longTasks: z.number().int().min(0).optional(),
    longTaskMsTotal: intMs.optional(),
    /** ≤5 条,入库前过统一脱敏网(longtask attribution 可含 containerSrc 等 URL)。 */
    slowestJson: sanitizedField(TELEMETRY_MAX_EVENT_DATA_BYTES).optional(),
})

/** 全部合法 (domain, kind) 及其 data 白名单。ingest 拒绝注册表外的 kind。 */
export const TELEMETRY_KINDS: Record<string, TelemetryKindSpec> = {
    // ux 域 → telemetry_events
    session_open: { domain: 'ux', minLevel: 1, data: SESSION_OPEN_DATA },
    session_close: { domain: 'ux', minLevel: 1, data: SESSION_CLOSE_DATA },
    data_loaded: { domain: 'ux', minLevel: 1, data: DATA_LOADED_DATA },
    client_window_inventory: { domain: 'ux', minLevel: 1, data: CLIENT_WINDOW_INVENTORY_DATA },
    session_pause_resume: { domain: 'ux', minLevel: 2, data: SESSION_PAUSE_RESUME_DATA },
    session_pin: { domain: 'ux', minLevel: 2, data: SESSION_PIN_DATA },
    session_switch: { domain: 'ux', minLevel: 2, data: SESSION_SWITCH_DATA },
    // diag 域 → telemetry_events
    js_error: { domain: 'diag', minLevel: 1, data: JS_ERROR_DATA },
    promise_rejection: { domain: 'diag', minLevel: 1, data: PROMISE_REJECTION_DATA },
    render_error: { domain: 'diag', minLevel: 1, data: RENDER_ERROR_DATA },
    sse_anomaly: { domain: 'diag', minLevel: 1, data: SSE_ANOMALY_DATA },
    load_incomplete: { domain: 'diag', minLevel: 1, data: LOAD_INCOMPLETE_DATA },
    load_slow: { domain: 'diag', minLevel: 1, data: LOAD_SLOW_DATA },
    send_stall: { domain: 'diag', minLevel: 1, data: SEND_STALL_DATA },
    turn_latency: { domain: 'diag', minLevel: 1, data: TURN_LATENCY_DATA },
    handled_error: { domain: 'diag', minLevel: 1, data: HANDLED_ERROR_DATA },
    // perf 域 → perf_samples / perf_sse_episodes / perf_web_vitals
    http: { domain: 'perf', minLevel: 1, data: HTTP_SAMPLE_DATA },
    sse_episode: { domain: 'perf', minLevel: 1, data: SSE_EPISODE_DATA },
    web_vital: { domain: 'perf', minLevel: 2, data: WEB_VITAL_DATA },
}

// ---------------------------------------------------------------------------
// 信封 schema
// ---------------------------------------------------------------------------

export const TelemetryDeviceSchema = z.object({
    /** localStorage 一次生成;非凭据非指纹(不跨 namespace 复用则连设备追踪都算不上)。 */
    id: shortStr(128),
    kind: z.enum(['browser', 'pwa', 'berry', 'telegram']),
    origin: z.enum(['direct', 'cf-orange', 'local']),
    dev: z.boolean().optional(),
})
export type TelemetryDevice = z.infer<typeof TelemetryDeviceSchema>

/** 事件 ts 合理墙钟下限(2000-01-01 UTC)。 */
export const TELEMETRY_TS_MIN_MS = Date.UTC(2000, 0, 1)

/**
 * 事件 ts 合理性检查:有限且落在 [2000-01-01, now+1 年] 墙钟窗口内
 * (上界按校验时刻求值)。防的是 1e300 这类有限但越界的毒值:zod v4 的
 * z.number() 只挡 NaN/Infinity,挡不住它;而 hub 侧
 * bucketKey(utcDay(ts)) 会对它抛 RangeError,把整个 ingest 事务炸回滚
 * (评审发现 #2)。刻意放在 validateTelemetryEvent(逐事件)而非
 * TelemetryEventSchema(整批):毒 ts 必须只拒该事件走 rejected 计数,
 * 不能把整批 400 掉让 SDK outbox 无限重试。
 */
export function isPlausibleTelemetryTs(ts: number): boolean {
    return Number.isFinite(ts)
        && ts >= TELEMETRY_TS_MIN_MS
        && ts <= Date.now() + 366 * 86_400_000
}

export const TelemetryEventSchema = z.object({
    /** crypto.randomUUID() = 幂等键(INSERT OR IGNORE,重复投递无害)。 */
    id: shortStr(64),
    ts: z.number(),
    /** 设备内单调序(丢批/乱序检测)。 */
    seq: z.number().int().min(0),
    domain: z.enum(['ux', 'diag', 'perf']),
    kind: shortStr(64),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    severity: z.enum(['error', 'warn', 'info']).optional(),
    sessionId: shortStr(128).optional(),
    fingerprint: shortStr(TELEMETRY_MAX_FINGERPRINT).optional(),
    data: z.record(z.string(), z.unknown()).default({}),
})
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

export const TelemetryBatchSchema = z.object({
    schema: z.literal(1),
    device: TelemetryDeviceSchema,
    /** __APP_VERSION__(vite 注入;fork 恒上游版本 → version 维兜底见报告 §6.3)。 */
    appVersion: shortStr(64),
    events: z.array(TelemetryEventSchema).max(TELEMETRY_MAX_EVENTS_PER_BATCH),
    /** 诚实性字段(fresh:false 惯例):丢旧计数 / flush 失败计数 / hub 200 响应
     *  内事件级拒收(schema,永久不重试)与按级丢弃的累计上报。 */
    meta: z
        .object({
            droppedOldest: z.number().int().min(0).optional(),
            flushFailures: z.number().int().min(0).optional(),
            serverRejected: z.number().int().min(0).optional(),
            serverDroppedByLevel: z.number().int().min(0).optional(),
        })
        .optional(),
})
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>

// ---------------------------------------------------------------------------
// 单事件校验(hub ingest 逐事件调用;未知 kind / 域错配 / data 白名单外 → 拒该事件不拒整批)
// ---------------------------------------------------------------------------

export type TelemetryEventValidation =
    | { ok: true; data: Record<string, unknown>; spec: TelemetryKindSpec }
    | { ok: false; reason: string }

const utf8Encoder = new TextEncoder()

export function validateTelemetryEvent(event: unknown): TelemetryEventValidation {
    const parsed = TelemetryEventSchema.safeParse(event)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return { ok: false, reason: `envelope:${issue?.path.join('.') ?? '?'}:${issue?.code ?? '?'}` }
    }
    const e = parsed.data
    // 毒 ts 防线(评审发现 #2):1e300 会让 hub 侧 utcDay(ts) 在 ingest
    // 事务内抛 RangeError;这里按事件拒绝,其余事件照常入库。
    if (!isPlausibleTelemetryTs(e.ts)) {
        return { ok: false, reason: `ts-range:${e.ts}` }
    }
    const spec = TELEMETRY_KINDS[e.kind]
    if (!spec) return { ok: false, reason: `unknown-kind:${e.kind}` }
    if (spec.domain !== e.domain) return { ok: false, reason: `domain-mismatch:${e.kind}:${e.domain}` }
    const data = spec.data.safeParse(e.data)
    if (!data.success) {
        const issue = data.error.issues[0]
        return { ok: false, reason: `data:${e.kind}:${issue?.path.join('.') ?? '?'}` }
    }
    try {
        const bytes = utf8Encoder.encode(JSON.stringify(data.data)).byteLength
        if (bytes > TELEMETRY_MAX_EVENT_DATA_BYTES) return { ok: false, reason: `data-oversize:${e.kind}:${bytes}` }
    } catch {
        return { ok: false, reason: `data-unserializable:${e.kind}` }
    }
    return { ok: true, data: data.data as Record<string, unknown>, spec }
}
