import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Row } from './fakeHub'
import pkg from '../../package.json'

interface ProcessFacts {
    out: string
    runtimeDir?: string
    cli: string
    marker: string
    pid: number
    apiUrl: string
    mcpPort: number
    startedAt: number
    endedAt: number
    leaseExpiry?: number
}

function channel(event: string) {
    if (event.startsWith('GET ') || event.startsWith('POST ')) return 'http'
    if (event.startsWith('messages-')) return 'messages-*'
    if (event === 'session-ready' || event === 'session-end') return 'lifecycle'
    if (['message', 'update-metadata', 'update-state', 'auth', 'rpc-register', 'session-alive', 'step'].includes(event)) return event
    return 'others'
}

export function normalize(rows: Row[], facts: ProcessFacts, launches: unknown[], decoded: unknown[]) {
    const runtimeDir = facts.runtimeDir ?? facts.cli
    const ids = new Map<string, string>()
    const requests = new Map<string, string>()
    const ports = new Map<string, string>()
    const clocks = new Map<string, number>()
    const methods: Record<string, string[]> = {}
    const alive: Record<string, { first: unknown; last: unknown }> = {}
    const channels: Record<string, unknown[]> = {}

    function token(map: Map<string, string>, value: string, name: string) {
        if (!map.has(value)) map.set(value, '<' + name + ':' + (map.size + 1) + '>')
        return map.get(value)!
    }

    function clean(value: any, key: string, path: string): any {
        if (Array.isArray(value)) return value.map(v => clean(v, '', path))
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
            .map(k => [k, clean(value[k], k, path + '/' + k)]))
        if (!path.startsWith('step/') && (['time', 'createdAt', 'lifecycleStateSince', 'completedAt', 'updatedAt', 'timestamp', 'agentTimestamp'].includes(key)
            || path.endsWith('/permissions/date'))) {
            if (key === 'timestamp') {
                assert.equal(typeof value, 'string', path)
                assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, path)
            }
            const stamp = key === 'timestamp' ? Date.parse(value) : value
            assert.ok(Number.isSafeInteger(stamp) && stamp >= (clocks.get(path) ?? 0), path)
            if (path !== 'decoded/createdAt') {
                assert.ok(stamp >= facts.startedAt - 1000 && stamp <= facts.endedAt, 'Timestamp outside run: ' + path)
            }
            clocks.set(path, stamp)
            return '<ts>'
        }
        if (path === 'rpc-ack/args/preparationLease/expiresAt') {
            assert.equal(value, facts.leaseExpiry)
            return '<lease-expiry>'
        }
        if (key === 'pid' || key === 'hostPid') { assert.equal(value, facts.pid); return '<pid>' }
        if (key === 'hostStartMarker' || key === 'processStartMarker') {
            assert.match(value, /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4}$/)
            assert.equal(value, facts.marker)
            return '<marker>'
        }
        if (path.endsWith('/metadata/version') || key === 'happyCliVersion') {
            assert.equal(value, pkg.version)
            return '<version>'
        }
        if (key === 'happyLibDir') { assert.equal(value, runtimeDir); return '<lib>' }
        if (key === 'happyToolsDir') { assert.equal(value, join(runtimeDir, 'tools/unpacked')); return '<tools>' }
        if (typeof value !== 'string') return value
        if (key === 'request_id') return token(requests, value, 'req')
        if (key === 'PATH') { assert.equal(value, process.env.PATH); return '<path>' }
        if (key === 'HAPI_API_URL') { assert.equal(value, facts.apiUrl); return '<hub>' }
        if (key === 'hapiMcpUrl') assert.equal(value, 'http://127.0.0.1:' + facts.mcpPort + '/')
        return value.replaceAll(facts.out, '<tmp>').replaceAll(facts.cli, '<lib>')
            .replace(/session-hook-(\d+)\.json/g, (_, pid) => {
                assert.equal(pid, String(facts.pid))
                return 'session-hook-<pid>.json'
            })
            .replace(/(127\.0\.0\.1:)(\d+)\//g, (_, host, port) => {
                assert.ok(Number(port) >= 1 && Number(port) <= 65535)
                assert.equal(Number(port), facts.mcpPort)
                return host + token(ports, port, 'port') + '/'
            })
            .replace(/(killSession\/process\/[^/]+\/)(\d+)$/, (_, prefix, pid) => {
                assert.equal(pid, String(facts.pid))
                return prefix + '<pid>'
            })
            .replace(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/gi, id => token(ids, id, 'uuid'))
    }

    const buckets = new Map<number, Map<string, Row[]>>()
    for (const row of rows) {
        const groups = buckets.get(row.step) ?? new Map<string, Row[]>()
        buckets.set(row.step, groups)
        const name = channel(row.event)
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name)!.push(row)
    }
    for (const step of [...buckets.keys()].sort((a, b) => a - b)) {
        const groups = buckets.get(step)!
        for (const name of [...groups.keys()].sort()) {
            for (const { event, connection, step: _, ...payload } of groups.get(name)!) {
                if (event === 'rpc-ack') payload.args = payload.args.map(v => JSON.parse(String(v)))
                if (event === 'message') {
                    const envelope = payload.args[0] as { createdAt?: number; message?: { content?: { type?: string; data?: { timestamp?: string } } } }
                    const content = envelope.message?.content
                    if (content?.type === 'output' && content.data?.timestamp !== undefined) {
                        assert.equal(envelope.createdAt, Date.parse(content.data.timestamp), 'Claude output creation time')
                    }
                }
                const normalized = clean(payload, '', event)
                if (event === 'rpc-register') {
                    const list = methods[connection] ??= []
                    if (!list.includes(normalized.args[0].method)) list.push(normalized.args[0].method)
                } else if (event === 'session-alive') {
                    assert.equal(normalized.ackRequested, false)
                    assert.equal(normalized.args.length, 1)
                    const { time, ...state } = normalized.args[0]
                    assert.equal(time, '<ts>', 'session-alive missing time')
                    alive[connection] ??= { first: state, last: state }
                    alive[connection].last = state
                } else {
                    const entries = channels[step + '/' + name] ??= []
                    entries.push({ event: clean(event, '', 'event'), connection, ...normalized })
                }
            }
        }
    }
    for (const list of Object.values(methods)) list.sort()
    return { methods, alive, channels, agent: clean(launches, '', 'agent'), decoded: clean(decoded, '', 'decoded') }
}
