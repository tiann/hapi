import { describe, expect, test } from 'bun:test'

import {
    TELEMETRY_KINDS,
    TELEMETRY_MAX_EVENTS_PER_BATCH,
    TELEMETRY_MAX_FINGERPRINT,
    TelemetryBatchSchema,
    normalizeApiPath,
    sanitizeTelemetryText,
    telemetryFingerprint,
    validateTelemetryEvent,
} from './telemetry'

// ---------------------------------------------------------------------------
// sanitizeTelemetryText(脱敏红线:四类凭据形态全部剥除)
// ---------------------------------------------------------------------------

describe('sanitizeTelemetryText', () => {
    test('strips Bearer tokens', () => {
        expect(sanitizeTelemetryText('Authorization failed for Bearer abc123def456ghi789')).toBe(
            'Authorization failed for Bearer [redacted]',
        )
    })
    test('strips sk- style keys', () => {
        expect(sanitizeTelemetryText('key sk-proj-1234567890abcdef rejected')).toBe('key sk-[redacted] rejected')
    })
    test('strips JWTs (three-segment and bare eyJ)', () => {
        expect(sanitizeTelemetryText('got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N65I.')).toContain('[redacted-jwt]')
        expect(sanitizeTelemetryText('leak eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9here')).toContain('[redacted-jwt]')
    })
    test('strips token= query-ish fragments (incl access_token via prefix char class)', () => {
        expect(sanitizeTelemetryText('url /sub?token=SECRETVALUE&x=1')).toBe('url /sub?token=[redacted]&x=1')
        expect(sanitizeTelemetryText('a&access_token=SECRETB')).toBe('a&access_token=[redacted]')
    })
    test('caps length after redaction (truncating redacted text cannot re-expose)', () => {
        const out = sanitizeTelemetryText('x'.repeat(5000), 100)
        expect(out.length).toBe(100)
    })
    test('keeps ordinary error text intact', () => {
        const msg = 'HTTP 500: internal error while listing sessions'
        expect(sanitizeTelemetryText(msg)).toBe(msg)
    })
})

// ---------------------------------------------------------------------------
// normalizeApiPath(双端逐字节一致;query 整串剥弃是一等红线)
// ---------------------------------------------------------------------------

describe('normalizeApiPath', () => {
    test('strips the whole query string — token must never survive', () => {
        expect(normalizeApiPath('GET', '/api/sessions?token=abc&view=slim')).toBe('/api/sessions')
        expect(normalizeApiPath('GET', '/events?token=JWTVALUE')).toBe('/events')
    })
    test('folds uuid segments to :id', () => {
        expect(normalizeApiPath('GET', '/api/sessions/3f2b8c1a-9d4e-4f6a-b1c2-112233445566/messages')).toBe(
            '/api/sessions/:id/messages',
        )
    })
    test('folds long hex and long numeric segments to :id', () => {
        expect(normalizeApiPath('GET', '/cli/machines/03b67e4eabcdef01/state')).toBe('/cli/machines/:id/state')
        expect(normalizeApiPath('GET', '/api/v2/things/123456')).toBe('/api/v2/things/:id')
    })
    test('keeps short literal segments untouched', () => {
        expect(normalizeApiPath('GET', '/api/bootstrap')).toBe('/api/bootstrap')
        expect(normalizeApiPath('POST', '/api/telemetry/events')).toBe('/api/telemetry/events')
    })
    test('stable and byte-identical across calls and ends (trailing slash collapsed)', () => {
        const a = normalizeApiPath('GET', '/api/sessions/3f2b8c1a-9d4e-4f6a-b1c2-112233445566/messages/')
        const b = normalizeApiPath('GET', '/api/sessions/3f2b8c1a-9d4e-4f6a-b1c2-112233445566/messages')
        expect(a).toBe(b)
        expect(a).toBe('/api/sessions/:id/messages')
    })
})

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

describe('telemetryFingerprint', () => {
    test('stable, bounded, name-prefixed', () => {
        const a = telemetryFingerprint('TypeError', 'cannot read properties')
        const b = telemetryFingerprint('TypeError', 'cannot read properties')
        const c = telemetryFingerprint('TypeError', 'other detail')
        expect(a).toBe(b)
        expect(a).not.toBe(c)
        expect(a.length).toBeLessThanOrEqual(TELEMETRY_MAX_FINGERPRINT)
        expect(a.startsWith('TypeError:')).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// kind 注册表完整性
// ---------------------------------------------------------------------------

describe('TELEMETRY_KINDS registry', () => {
    test('every kind has a valid domain, minLevel and zod schema', () => {
        for (const [kind, spec] of Object.entries(TELEMETRY_KINDS)) {
            expect(['ux', 'diag', 'perf']).toContain(spec.domain)
            expect([1, 2, 3]).toContain(spec.minLevel)
            expect(spec.data).toBeDefined()
            expect(kind.length).toBeGreaterThan(0)
        }
    })
    test('P0 kinds present (incl revision additions turn_latency / client_window_inventory)', () => {
        for (const kind of [
            'session_open',
            'session_close',
            'data_loaded',
            'client_window_inventory',
            'js_error',
            'promise_rejection',
            'render_error',
            'sse_anomaly',
            'load_incomplete',
            'load_slow',
            'send_stall',
            'turn_latency',
            'http',
            'sse_episode',
        ]) {
            expect(TELEMETRY_KINDS[kind]).toBeDefined()
        }
    })
})

// ---------------------------------------------------------------------------
// 单事件校验(ingest 白名单 + 二道脱敏网)
// ---------------------------------------------------------------------------

const baseEvent = {
    id: '0d8ee7fb-1111-4222-8333-444455556666',
    ts: 1732000000000,
    seq: 3,
    level: 1 as const,
}

describe('validateTelemetryEvent', () => {
    test('accepts a well-formed ux session_open', () => {
        const r = validateTelemetryEvent({
            ...baseEvent,
            domain: 'ux',
            kind: 'session_open',
            sessionId: 'sess-1',
            data: { entry: 'list-click', openedAt: 1234 },
        })
        expect(r.ok).toBe(true)
    })
    test('rejects unknown kind and domain mismatch without touching the rest', () => {
        expect(validateTelemetryEvent({ ...baseEvent, domain: 'ux', kind: 'nope', data: {} }).ok).toBe(false)
        expect(
            validateTelemetryEvent({ ...baseEvent, domain: 'ux', kind: 'http', data: { method: 'GET', pathTpl: '/x', status: 200, totalMs: 5 } }).ok,
        ).toBe(false)
    })
    test('rejects data outside the per-kind whitelist', () => {
        const r = validateTelemetryEvent({
            ...baseEvent,
            domain: 'ux',
            kind: 'session_open',
            data: { entry: 'not-a-real-entry', openedAt: 1 },
        })
        expect(r.ok).toBe(false)
    })
    test('second-pass sanitization: credentials in messageHead are redacted even if client forgot', () => {
        const r = validateTelemetryEvent({
            ...baseEvent,
            domain: 'diag',
            kind: 'js_error',
            data: { name: 'Error', messageHead: 'failed with Bearer aaaaaaaaaaaaaaaa and token=zzzz' },
        })
        expect(r.ok).toBe(true)
        if (r.ok) {
            expect(r.data.messageHead).not.toContain('aaaaaaaaaaaaaaaa')
            expect(r.data.messageHead).not.toContain('zzzz')
            expect(String(r.data.messageHead)).toContain('[redacted]')
        }
    })
    test('oversize data is rejected', () => {
        const r = validateTelemetryEvent({
            ...baseEvent,
            domain: 'ux',
            kind: 'client_window_inventory',
            data: {
                sessionsHeld: 1,
                storageUsedBytes: 1,
                windows: Array.from({ length: 128 }, () => ({ messageCount: 1, approxBytes: 2, persisted: true, active: false })),
            },
        })
        // 128 entries × ~60B ≈ 7.7KB > 4KB → data-oversize;若 schema 层已拒同样 ok=false
        expect(r.ok).toBe(false)
    })
    test('ts 毒丸防御(评审 #2):1e300 这类越界墙钟值按事件拒绝,不进事务', () => {
        // 1e300 有限,zod v4 的 z.number() 挡不住;曾把 hub 侧 utcDay(ts)
        // 在 ingest 事务内炸成 RangeError → 整批回滚 + 500。
        const ev = (ts: number) => validateTelemetryEvent({
            ...baseEvent, ts, domain: 'ux', kind: 'session_open', data: { entry: 'list-click', openedAt: 1 }
        })
        expect(ev(1e300).ok).toBe(false)
        // 同样拒绝:过老的墙钟(2000-01-01 之前)与未来超过 1 年
        expect(ev(Date.UTC(1999, 11, 31)).ok).toBe(false)
        expect(ev(Date.now() + 400 * 86_400_000).ok).toBe(false)
        // 边界内照常接受:现在 / 过去一周 / 未来一个月
        expect(ev(Date.now()).ok).toBe(true)
        expect(ev(Date.now() - 7 * 86_400_000).ok).toBe(true)
        expect(ev(Date.now() + 30 * 86_400_000).ok).toBe(true)
        // 整批 schema 刻意不拒毒 ts(拒整批 = 400 → SDK outbox 无限重试);
        // 逐事件防线在 validateTelemetryEvent。
        const poisonedBatch = TelemetryBatchSchema.safeParse({
            schema: 1,
            device: { id: 'dev-1', kind: 'pwa' as const, origin: 'cf-orange' as const },
            appVersion: '0.36.5',
            events: [{ ...baseEvent, ts: 1e300, domain: 'ux', kind: 'session_open', data: { entry: 'list-click', openedAt: 1 } }]
        })
        expect(poisonedBatch.success).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

describe('TelemetryBatchSchema', () => {
    const device = { id: 'dev-1', kind: 'pwa' as const, origin: 'cf-orange' as const }
    test('accepts a valid batch', () => {
        const r = TelemetryBatchSchema.safeParse({
            schema: 1,
            device,
            appVersion: '0.36.5',
            events: [{ ...baseEvent, domain: 'ux', kind: 'session_open', data: { entry: 'url-direct', openedAt: 1 } }],
            meta: { droppedOldest: 2 },
        })
        expect(r.success).toBe(true)
    })
    test('rejects batches over the event cap', () => {
        const events = Array.from({ length: TELEMETRY_MAX_EVENTS_PER_BATCH + 1 }, () => ({
            ...baseEvent,
            domain: 'ux',
            kind: 'session_open',
            data: { entry: 'url-direct', openedAt: 1 },
        }))
        expect(TelemetryBatchSchema.safeParse({ schema: 1, device, appVersion: '0.36.5', events }).success).toBe(false)
    })
    test('rejects unknown device kinds', () => {
        expect(
            TelemetryBatchSchema.safeParse({ schema: 1, device: { id: 'd', kind: 'fridge', origin: 'local' }, appVersion: '0', events: [] }).success,
        ).toBe(false)
    })
})
