import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentAvailability from './agentAvailability'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import {
    _resetAgentQuotasCacheForTests,
    _setClaudeStatusProbeForTests,
    extractClaudeUsageBuckets,
    extractCodexQuotaBuckets,
    getAgentQuotasResponse,
    parseAgyCreditsCommandJson,
    parseAgyUsageCommandJson,
    parseClaudeQuotaControlLine,
    probeAgyQuota,
    probeClaudeQuota,
    probeCodexQuota,
    recordAgyTier,
    recordClaudeRateLimitEvent,
    recordCodexRateLimitsUpdate
} from './agentQuotas'

describe('agentQuotas parsers and probes', () => {
    beforeEach(() => {
        _resetAgentQuotasCacheForTests()
        vi.restoreAllMocks()
    })

    function createFakeAgy(): { directory: string; eventLog: string; usageDone: string; env: NodeJS.ProcessEnv } {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-agy-fake-'))
        const eventLog = join(directory, 'events.log')
        const usageDone = join(directory, 'usage-done')
        const executable = join(directory, 'agy')
        writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "$AGY_EVENT_LOG"
if [ "$1" = "models" ]; then
    if [ -n "$AGY_FAKE_MODELS_DELAY" ]; then
        sleep "$AGY_FAKE_MODELS_DELAY"
    fi
    if [ "$AGY_FAKE_MODELS_FAIL" = "hang" ]; then
        sleep 6
        echo 'gemini-3-pro'
        exit 0
    fi
    if [ "$AGY_FAKE_AUTH" = "unauthenticated" ]; then
        echo 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.' >&2
        exit 1
    fi
    if [ "$AGY_FAKE_MODELS_FAIL" = "exit1-other" ]; then
        echo 'Error: configuration file is invalid' >&2
        exit 1
    fi
    if [ "$AGY_FAKE_MODELS_FAIL" = "exit2" ]; then
        echo 'unexpected failure' >&2
        exit 2
    fi
    echo 'gemini-3-pro'
    exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/usage" ]; then
    echo usage-start >> "$AGY_EVENT_LOG"
    if [ "$AGY_FAKE_USAGE_FAIL" = "hang" ]; then
        sleep 6
    fi
    sleep 0.1
    : > "$AGY_USAGE_DONE"
    echo usage-complete >> "$AGY_EVENT_LOG"
    echo '{"command":{"name":"usage","data":{"groups":[]}}}'
    if [ -n "$AGY_FAKE_USAGE_EXIT" ]; then
        exit "$AGY_FAKE_USAGE_EXIT"
    fi
    exit 0
fi
if [ "$1" = "-p" ] && [ "$2" = "/credits" ]; then
    if [ ! -f "$AGY_USAGE_DONE" ]; then
        echo credits-before-usage-complete >> "$AGY_EVENT_LOG"
    fi
    echo credits-start >> "$AGY_EVENT_LOG"
    echo '{"command":{"name":"credits","data":{"remaining_credits":10}}}'
    exit 0
fi
exit 2
`, 'utf8')
        chmodSync(executable, 0o755)
        return {
            directory,
            eventLog,
            usageDone,
            env: {
                ...process.env,
                PATH: `${directory}:${process.env.PATH ?? ''}`,
                AGY_EVENT_LOG: eventLog,
                AGY_USAGE_DONE: usageDone
            }
        }
    }

    it('does not run agy print commands after the non-interactive models check reports unauthenticated', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_AUTH: 'unauthenticated' }
            const first = await probeAgyQuota(env)
            const second = await probeAgyQuota(env)
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')

            expect(first.status).toBe('unauthenticated')
            expect(second.status).toBe('unauthenticated')
            expect(events).toEqual(['models'])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('rechecks agy auth immediately when an explicit refresh bypasses the unauthenticated cache', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_AUTH: 'unauthenticated' }
            expect((await probeAgyQuota(env)).status).toBe('unauthenticated')
            // a normal poll within the negative-cache window short-circuits without spawning
            expect((await probeAgyQuota(env)).status).toBe('unauthenticated')
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models'])

            // explicit refresh bypasses the negative cache and re-runs the safe models check
            expect((await probeAgyQuota(env, { refresh: true })).status).toBe('unauthenticated')
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models', 'models'])

            // the user signs in; refresh recovers to ok without waiting out the cache
            const recovered = await probeAgyQuota(fakeAgy.env, { refresh: true })
            expect(recovered.status).toBe('ok')
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual([
                'models',
                'models',
                'models',
                '-p /usage --output-format json',
                'usage-start',
                'usage-complete',
                '-p /credits --output-format json',
                'credits-start'
            ])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('single-flights the agy probe across concurrent callers including refresh', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_MODELS_DELAY: '0.3' }
            const [first, second, third] = await Promise.all([
                probeAgyQuota(env),
                probeAgyQuota(env, { refresh: true }),
                probeAgyQuota(env)
            ])

            expect(first.status).toBe('ok')
            expect(second.status).toBe('ok')
            expect(third.status).toBe('ok')
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')
            expect(events.filter((event) => event === 'models')).toHaveLength(1)
            expect(events.filter((event) => event.startsWith('-p /usage'))).toHaveLength(1)
            expect(events.filter((event) => event.startsWith('-p /credits'))).toHaveLength(1)

            // the inflight guard clears after completion so later probes run fresh
            await probeAgyQuota(env)
            const eventsAfter = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')
            expect(eventsAfter.filter((event) => event === 'models')).toHaveLength(2)
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('reports an error status without print commands when the models check fails for reasons other than the sign-in message', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'exit2' }
            const first = await probeAgyQuota(env)
            expect(first.status).toBe('error')
            expect(first.note).toBeTruthy()
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models'])

            // a short error cache keeps immediate polls from re-spawning the check
            expect((await probeAgyQuota(env)).status).toBe('error')
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models'])

            // refresh bypasses the short error cache and re-runs the safe check
            expect((await probeAgyQuota(env, { refresh: true })).status).toBe('error')
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models', 'models'])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('keeps exit 1 without the sign-in message out of the unauthenticated status', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'exit1-other' }
            const result = await probeAgyQuota(env)

            expect(result.status).toBe('error')
            expect(result.note).toBeTruthy()
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models'])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('returns an error status when the models check times out and never runs print commands', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'hang' }
            const startedAt = Date.now()
            const result = await probeAgyQuota(env)

            expect(result.status).toBe('error')
            expect(Date.now() - startedAt).toBeLessThan(9_000)
            expect(readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')).toEqual(['models'])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    }, 15_000)

    it('treats a non-zero usage exit as an error even when the usage JSON parses', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_USAGE_EXIT: '7' }
            const result = await probeAgyQuota(env)

            expect(result.status).toBe('error')
            expect(result.buckets).toEqual([])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('clears the auth caches after a successful probe so the next normal poll recovers', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const unauthEnv = { ...fakeAgy.env, AGY_FAKE_AUTH: 'unauthenticated' }
            expect((await probeAgyQuota(unauthEnv)).status).toBe('unauthenticated')

            // the user signs in; an explicit refresh recovers
            expect((await probeAgyQuota(fakeAgy.env, { refresh: true })).status).toBe('ok')

            // a normal poll right after must also recover, not short-circuit back to
            // the stale unauthenticated cache
            const next = await probeAgyQuota(fakeAgy.env)
            expect(next.status).toBe('ok')
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')
            expect(events.filter((event) => event === 'models')).toHaveLength(3)
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('caches the error after a failed usage command so immediate polls do not re-spawn', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_USAGE_EXIT: '7' }
            expect((await probeAgyQuota(env)).status).toBe('error')

            const next = await probeAgyQuota(env)
            expect(next.status).toBe('error')
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')
            expect(events.filter((event) => event === 'models')).toHaveLength(1)
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('caches the error after a usage timeout so immediate polls do not re-spawn', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const env = { ...fakeAgy.env, AGY_FAKE_USAGE_FAIL: 'hang' }
            const timedOut = await probeAgyQuota(env)
            expect(timedOut.status).toBe('error')
            expect(timedOut.note).toContain('timed out')

            const next = await probeAgyQuota(env)
            expect(next.status).toBe('error')
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')
            expect(events.filter((event) => event === 'models')).toHaveLength(1)
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    }, 15_000)

    it('clears the single-flight guard on every failure path so the next call can run', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const modelEvents = () =>
                readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n').filter((event) => event === 'models').length

            // preflight error (models exit 2)
            const preflightEnv = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'exit2' }
            expect((await probeAgyQuota(preflightEnv)).status).toBe('error')
            expect((await probeAgyQuota(preflightEnv, { refresh: true })).status).toBe('error')
            expect(modelEvents()).toBe(2)

            // usage timeout
            const usageEnv = { ...fakeAgy.env, AGY_FAKE_USAGE_FAIL: 'hang' }
            expect((await probeAgyQuota(usageEnv, { refresh: true })).status).toBe('error')
            expect((await probeAgyQuota(usageEnv, { refresh: true })).status).toBe('error')
            expect(modelEvents()).toBe(4)

            // preflight timeout
            const hangEnv = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'hang' }
            expect((await probeAgyQuota(hangEnv, { refresh: true })).status).toBe('error')
            expect((await probeAgyQuota(hangEnv, { refresh: true })).status).toBe('error')
            expect(modelEvents()).toBe(6)

            // non-zero usage exit
            const exitEnv = { ...fakeAgy.env, AGY_FAKE_USAGE_EXIT: '7' }
            expect((await probeAgyQuota(exitEnv, { refresh: true })).status).toBe('error')
            expect((await probeAgyQuota(exitEnv, { refresh: true })).status).toBe('error')
            expect(modelEvents()).toBe(8)
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    }, 30_000)

    it('keeps a single live negative verdict when a refresh-time models failure follows an unauthenticated probe', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const unauthEnv = { ...fakeAgy.env, AGY_FAKE_AUTH: 'unauthenticated' }
            expect((await probeAgyQuota(unauthEnv)).status).toBe('unauthenticated')

            // signed in, but the check itself fails operationally during a refresh
            const failingEnv = { ...fakeAgy.env, AGY_FAKE_MODELS_FAIL: 'hang' }
            expect((await probeAgyQuota(failingEnv, { refresh: true })).status).toBe('error')

            // only the latest verdict stays live: the next normal poll reports the
            // recorded error (short cache), not the stale "Not signed in"
            expect((await probeAgyQuota(fakeAgy.env)).status).toBe('error')

            // refresh recovers once the operational failure clears
            expect((await probeAgyQuota(fakeAgy.env, { refresh: true })).status).toBe('ok')
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    }, 15_000)

    it('runs agy credits only after the usage command completes', async () => {
        const fakeAgy = createFakeAgy()
        try {
            const result = await probeAgyQuota(fakeAgy.env)
            const events = readFileSync(fakeAgy.eventLog, 'utf8').trim().split('\n')

            expect(result.status).toBe('ok')
            expect(events).toEqual([
                'models',
                '-p /usage --output-format json',
                'usage-start',
                'usage-complete',
                '-p /credits --output-format json',
                'credits-start'
            ])
        } finally {
            rmSync(fakeAgy.directory, { recursive: true, force: true })
        }
    })

    it('extracts Codex rate limit buckets across primary, secondary, and rateLimitsByLimitId', () => {
        const buckets = extractCodexQuotaBuckets({
            rateLimits: {
                limitId: 'codex',
                primary: {
                    usedPercent: 18,
                    windowDurationMins: 10080,
                    resetsAt: 1794651962
                },
                secondary: {
                    usedPercent: 45,
                    windowDurationMins: 300,
                    resetsAt: 1794400000
                },
                credits: {
                    hasCredits: true,
                    unlimited: false,
                    balance: '240'
                },
                planType: 'pro'
            },
            rateLimitsByLimitId: {
                codex: {
                    limitId: 'codex',
                    primary: {
                        usedPercent: 18,
                        windowDurationMins: 10080,
                        resetsAt: 1794651962
                    }
                },
                codex_fast: {
                    limitId: 'codex_fast',
                    limitName: 'Fast tier',
                    primary: {
                        usedPercent: 10,
                        windowDurationMins: 1440,
                        resetsAt: 1794450000
                    }
                }
            },
            rateLimitResetCredits: {
                availableCount: 1,
                nextGrantAt: 1796788800
            }
        })

        expect(buckets).toEqual([
            {
                id: 'codex-primary',
                label: 'Weekly (7d)',
                group: null,
                window: 'weekly',
                usedPercent: 18,
                remainingPercent: 82,
                resetsAt: 1794651962 * 1000
            },
            {
                id: 'codex-secondary',
                label: '5h window',
                group: null,
                window: '5h',
                usedPercent: 45,
                remainingPercent: 55,
                resetsAt: 1794400000 * 1000
            },
            {
                id: 'codex_fast-primary',
                label: 'Fast tier · Daily (24h)',
                group: 'Fast tier',
                window: '24h',
                usedPercent: 10,
                remainingPercent: 90,
                resetsAt: 1794450000 * 1000
            }
        ])
    })

    it('parses Antigravity /usage and /credits JSON outputs including unauthenticated messages', () => {
        const usageJson = JSON.stringify({
            session_id: 's1',
            response: 'Quota remaining...',
            command: {
                name: 'usage',
                data: {
                    groups: [
                        {
                            name: 'Gemini Models',
                            buckets: [
                                {
                                    id: 'gemini-5h',
                                    window: '5h',
                                    remaining_fraction: 1,
                                    reset_time: '2026-11-11T18:22:22Z'
                                },
                                {
                                    id: 'gemini-weekly',
                                    window: 'weekly',
                                    remaining_fraction: 0.785,
                                    reset_time: '2026-11-15T16:45:43Z'
                                }
                            ]
                        },
                        {
                            name: 'Claude and GPT models',
                            buckets: [
                                {
                                    id: 'claude-5h',
                                    window: '5h',
                                    remaining_fraction: 0.4,
                                    reset_time: '2026-11-11T16:59:11Z'
                                }
                            ]
                        }
                    ]
                }
            }
        })

        const parsedUsage = parseAgyUsageCommandJson(usageJson)
        expect(parsedUsage?.buckets).toHaveLength(3)
        expect(parsedUsage?.buckets[0]).toEqual({
            id: 'gemini-5h',
            label: 'Gemini Models · 5h',
            group: 'Gemini Models',
            window: '5h',
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: Date.parse('2026-11-11T18:22:22Z')
        })
        expect(parsedUsage?.buckets[1]).toEqual({
            id: 'gemini-weekly',
            label: 'Gemini Models · Weekly',
            group: 'Gemini Models',
            window: 'weekly',
            usedPercent: 21.5,
            remainingPercent: 78.5,
            resetsAt: Date.parse('2026-11-15T16:45:43Z')
        })

        expect(parseAgyUsageCommandJson('Error: Please sign in to continue')).toEqual({
            buckets: [],
            unauthenticated: true
        })

        const creditsJson = JSON.stringify({
            command: {
                name: 'credits',
                data: {
                    remaining_credits: 1500
                }
            }
        })
        expect(parseAgyCreditsCommandJson(creditsJson)).toBe(1500)
    })

    it('parses Claude control_response lines for initialize and get_status', () => {
        const target = {
            account: null as Record<string, unknown> | null,
            statusRows: new Map<string, string>()
        }

        const initStep = parseClaudeQuotaControlLine(JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'hapi-claude-quota-init',
                response: {
                    account: {
                        email: 'dev@example.com',
                        subscriptionType: 'Claude Max'
                    }
                }
            }
        }), target)
        expect(initStep).toEqual({ initDone: true, statusDone: false, usageDone: false })
        expect(target.account).toEqual({
            email: 'dev@example.com',
            subscriptionType: 'Claude Max'
        })

        const statusStep = parseClaudeQuotaControlLine(JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'hapi-claude-quota-status',
                response: {
                    sections: [
                        {
                            title: '',
                            rows: [
                                { label: 'Auth token', value: 'apiKeyHelper' },
                                { label: 'Anthropic base URL', value: 'https://any.s6o.org' }
                            ]
                        }
                    ]
                }
            }
        }), target)
        expect(statusStep).toEqual({ initDone: false, statusDone: true, usageDone: false })
        expect(Object.fromEntries(target.statusRows.entries())).toEqual({
            'Auth token': 'apiKeyHelper',
            'Anthropic base URL': 'https://any.s6o.org'
        })
    })

    it('parses Claude get_usage control_response and tolerates CLIs that reject it', () => {
        const target = {
            account: null as Record<string, unknown> | null,
            statusRows: new Map<string, string>(),
            rateLimits: undefined as Record<string, unknown> | null | undefined
        }
        const rateLimits = {
            five_hour: { utilization: 2, resets_at: '2026-11-16T18:49:59.838188+00:00' },
            seven_day: { utilization: 0, resets_at: '2026-11-19T15:59:59.838209+00:00' },
            seven_day_opus: null
        }

        const usageStep = parseClaudeQuotaControlLine(JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: 'hapi-claude-quota-usage',
                response: { subscription_type: 'pro', rate_limits_available: true, rate_limits: rateLimits }
            }
        }), target)
        expect(usageStep).toEqual({ initDone: false, statusDone: false, usageDone: true })
        expect(target.rateLimits).toEqual(rateLimits)

        const errorStep = parseClaudeQuotaControlLine(JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'error',
                request_id: 'hapi-claude-quota-usage',
                error: 'Unsupported control request subtype: get_usage'
            }
        }), target)
        expect(errorStep).toEqual({ initDone: false, statusDone: false, usageDone: true })
        expect(target.rateLimits).toBeNull()
    })

    it('extracts Claude 5h and weekly buckets from get_usage rate limits', () => {
        expect(extractClaudeUsageBuckets({
            five_hour: { utilization: 37.5, resets_at: '2026-11-16T18:49:59.838Z' },
            seven_day: { utilization: 120, resets_at: null },
            seven_day_opus: { utilization: 50, resets_at: null },
            extra_usage: { is_enabled: false, utilization: null }
        })).toEqual([
            {
                id: 'claude-five_hour',
                label: '5h window',
                group: null,
                window: '5h',
                usedPercent: 37.5,
                remainingPercent: 62.5,
                resetsAt: Date.parse('2026-11-16T18:49:59.838Z')
            },
            {
                id: 'claude-seven_day',
                label: 'Weekly (7d)',
                group: null,
                window: 'weekly',
                usedPercent: 100,
                remainingPercent: 0,
                resetsAt: null
            }
        ])
        expect(extractClaudeUsageBuckets(null)).toEqual([])
        expect(extractClaudeUsageBuckets({ five_hour: { utilization: null, resets_at: null }, seven_day: null })).toEqual([])
    })

    it('prefers get_usage windows over live rate_limit_event observations and keeps the rest', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-usage-probe-'))
        try {
            const env = { HAPI_HOME: hapiHome }
            const resetSec = Math.floor(Date.now() / 1000) + 3600
            recordClaudeRateLimitEvent({
                status: 'allowed_warning',
                rateLimitType: 'five_hour',
                utilization: 0.85,
                resetsAt: resetSec
            }, env, 'userA@example.com')
            recordClaudeRateLimitEvent({
                status: 'allowed_warning',
                rateLimitType: 'seven_day_opus',
                utilization: 0.5,
                resetsAt: resetSec
            }, env, 'userA@example.com')

            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Pro' },
                statusRows: new Map([['Email', 'userA@example.com']]),
                rateLimits: {
                    five_hour: { utilization: 12, resets_at: '2026-11-16T18:00:00Z' },
                    seven_day: { utilization: 40, resets_at: '2026-11-19T16:00:00Z' }
                }
            }))

            const claude = await probeClaudeQuota(env)
            expect(claude.status).toBe('ok')
            expect(claude.note).toBeNull()
            expect(claude.buckets.map((bucket) => [bucket.id, bucket.usedPercent])).toEqual([
                ['claude-five_hour', 12],
                ['claude-seven_day', 40],
                ['claude-seven_day_opus', 50]
            ])
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('probes Codex account and rate limits and formats credits and plan', async () => {
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockReturnValue({
            agent: 'codex',
            available: true
        })
        vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue(undefined)
        vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockResolvedValue({} as never)
        vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockResolvedValue(undefined)
        vi.spyOn(CodexAppServerClient.prototype, 'readAccount').mockResolvedValue({
            account: {
                type: 'chatgpt',
                email: 'user@example.com',
                planType: 'pro'
            }
        })
        vi.spyOn(CodexAppServerClient.prototype, 'readRateLimits').mockResolvedValue({
            rateLimits: {
                limitId: 'codex',
                primary: {
                    usedPercent: 12,
                    windowDurationMins: 10080,
                    resetsAt: 1794900000
                },
                credits: {
                    hasCredits: true,
                    unlimited: false,
                    balance: 1250.5
                }
            },
            rateLimitResetCredits: {
                availableCount: 2
            }
        })

        const result = await probeCodexQuota({})
        expect(result.status).toBe('ok')
        expect(result.accountLabel).toBe('user@example.com')
        expect(result.planLabel).toBe('Pro')
        expect(result.creditsLabel).toBe('1,250.5 credits · 2 free resets')
        expect(result.buckets).toHaveLength(1)
        expect(result.buckets[0]?.remainingPercent).toBe(88)
    })

    it('returns unavailable when CLI is not installed and caches getAgentQuotasResponse until invalidated', async () => {
        const availabilitySpy = vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
            agent,
            available: false
        }))

        recordAgyTier('Google AI Ultra')
        recordClaudeRateLimitEvent({
            status: 'allowed',
            rateLimitType: 'five_hour',
            utilization: 0.35,
            resetsAt: Math.floor(Date.now() / 1000) + 3600
        })

        const first = await getAgentQuotasResponse({ env: {} })
        expect(first.accounts.map((a) => a.status)).toEqual(['unavailable', 'unavailable', 'unavailable'])
        expect(availabilitySpy).toHaveBeenCalledTimes(3)

        const second = await getAgentQuotasResponse({ env: {} })
        expect(second.fetchedAt).toBe(first.fetchedAt)
        expect(availabilitySpy).toHaveBeenCalledTimes(3)

        recordCodexRateLimitsUpdate({ rateLimits: {} })
        const third = await getAgentQuotasResponse({ env: {} })
        expect(availabilitySpy).toHaveBeenCalledTimes(6)
        expect(third.accounts).toHaveLength(3)
    })

    it('handles unavailable status in probeAgyQuota and probeClaudeQuota directly', async () => {
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
            agent,
            available: false
        }))

        const agy = await probeAgyQuota({})
        const claude = await probeClaudeQuota({})
        expect(agy.status).toBe('unavailable')
        expect(claude.status).toBe('unavailable')
    })

    it('shares live quota observations across process boundaries, isolates session credentials, and binds to the producing session account across switches', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-live-quotas-'))
        try {
            const runnerEnv = { HOME: hapiHome, HAPI_HOME: hapiHome }
            const resetSec = Math.floor(Date.now() / 1000) + 3600

            // Write HOME/.claude.json for userA while HAPI_HOME is also configured
            writeFileSync(
                join(hapiHome, '.claude.json'),
                JSON.stringify({ oauthAccount: { emailAddress: 'userA@example.com' } }),
                'utf8'
            )

            // 1. Separate OS child process (default credentials) records a five_hour observation via SDKToLogConverter
            const childScript = `
                import { SDKToLogConverter } from './src/claude/utils/sdkToLogConverter.ts';
                const converter = new SDKToLogConverter({
                    sessionId: 'session-a',
                    cwd: process.cwd()
                });
                converter.convert({
                    type: 'rate_limit_event',
                    rate_limit_info: {
                        status: 'allowed',
                        rateLimitType: 'five_hour',
                        utilization: 0.4,
                        resetsAt: ${resetSec}
                    }
                });
            `
            const childRes = spawnSync('bun', ['-e', childScript], {
                cwd: process.cwd(),
                env: {
                    PATH: process.env.PATH,
                    HOME: hapiHome,
                    HAPI_HOME: hapiHome
                },
                encoding: 'utf8'
            })
            expect(childRes.status).toBe(0)

            // 2. Separate OS child process with its own CLAUDE_CODE_OAUTH_TOKEN records a conflicting observation
            const tokenChildScript = `
                import { recordClaudeRateLimitEvent } from './src/agent/agentQuotas.ts';
                recordClaudeRateLimitEvent({
                    status: 'allowed',
                    rateLimitType: 'five_hour',
                    utilization: 0.95,
                    resetsAt: ${resetSec}
                });
            `
            const tokenChildRes = spawnSync('bun', ['-e', tokenChildScript], {
                cwd: process.cwd(),
                env: {
                    PATH: process.env.PATH,
                    HOME: hapiHome,
                    HAPI_HOME: hapiHome,
                    CLAUDE_CODE_OAUTH_TOKEN: 'session-specific-oauth-token-b'
                },
                encoding: 'utf8'
            })
            expect(tokenChildRes.status).toBe(0)

            // Simulate separate runner process (clear module-local memory)
            _resetAgentQuotasCacheForTests()
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Max' },
                statusRows: new Map([
                    ['Email', 'userA@example.com'],
                    ['Login method', 'Claude Max Account']
                ])
            }))

            const first = await getAgentQuotasResponse({ env: runnerEnv })
            const claudeFirst = first.accounts.find((a) => a.agent === 'claude')
            expect(claudeFirst?.status).toBe('ok')
            expect(claudeFirst?.accountLabel).toBe('userA@example.com')
            // Must return the 40% observation for userA, NOT the 95% observation from session B's token
            expect(claudeFirst?.buckets).toHaveLength(1)
            expect(claudeFirst?.buckets[0]?.usedPercent).toBe(40)
            expect(claudeFirst?.buckets[0]?.remainingPercent).toBe(60)

            // 3. Switch machine default Claude account to userB@example.com while a userA session is still running
            const lateSessionAScript = `
                import { writeFileSync } from 'node:fs';
                import { join } from 'node:path';
                import { SDKToLogConverter } from './src/claude/utils/sdkToLogConverter.ts';
                // Session A starts while HOME/.claude.json is still userA@example.com
                const converterA = new SDKToLogConverter({
                    sessionId: 'session-a-long-running',
                    cwd: process.cwd()
                });
                // Host config then switches to userB@example.com
                writeFileSync(
                    join(process.env.HOME, '.claude.json'),
                    JSON.stringify({ oauthAccount: { emailAddress: 'userB@example.com' } }),
                    'utf8'
                );
                // Session A emits a new event after the switch; it must stay bound to userA
                converterA.convert({
                    type: 'rate_limit_event',
                    rate_limit_info: {
                        status: 'allowed',
                        rateLimitType: 'five_hour',
                        utilization: 0.75,
                        resetsAt: ${resetSec}
                    }
                });
            `
            _resetAgentQuotasCacheForTests()
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userB@example.com', subscriptionType: 'Claude Pro' },
                statusRows: new Map([
                    ['Email', 'userB@example.com'],
                    ['Login method', 'Claude Pro Account']
                ])
            }))

            // Runner probes userB first
            const beforeLateEvent = await probeClaudeQuota(runnerEnv)
            expect(beforeLateEvent.accountLabel).toBe('userB@example.com')
            expect(beforeLateEvent.buckets).toEqual([])

            // Then the still-running userA session emits its late event after runner probed userB
            const lateRes = spawnSync('bun', ['-e', lateSessionAScript], {
                cwd: process.cwd(),
                env: {
                    PATH: process.env.PATH,
                    HOME: hapiHome,
                    HAPI_HOME: hapiHome
                },
                encoding: 'utf8'
            })
            expect(lateRes.status).toBe(0)

            // Probing userB still must NOT inherit session A's late event
            const afterLateEventB = await probeClaudeQuota(runnerEnv)
            expect(afterLateEventB.accountLabel).toBe('userB@example.com')
            expect(afterLateEventB.buckets).toEqual([])

            // Probing userA sees the updated 75% bucket
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Max' },
                statusRows: new Map([
                    ['Email', 'userA@example.com'],
                    ['Login method', 'Claude Max Account']
                ])
            }))
            const afterLateEventA = await probeClaudeQuota(runnerEnv)
            expect(afterLateEventA.accountLabel).toBe('userA@example.com')
            expect(afterLateEventA.buckets).toHaveLength(1)
            expect(afterLateEventA.buckets[0]?.usedPercent).toBe(75)
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('preserves concurrent live quota writes across simultaneous OS processes', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-concurrent-quotas-'))
        try {
            const env = { HAPI_HOME: hapiHome }
            const resetSec = Math.floor(Date.now() / 1000) + 3600

            const runChildProcess = (script: string): Promise<void> =>
                new Promise((resolve, reject) => {
                    const child = spawn('bun', ['-e', script], {
                        cwd: process.cwd(),
                        env: {
                            PATH: process.env.PATH,
                            HOME: hapiHome,
                            HAPI_HOME: hapiHome
                        },
                        stdio: 'ignore'
                    })
                    child.on('error', reject)
                    child.on('close', (code) => {
                        if (code === 0) resolve()
                        else reject(new Error(`Child exited with code ${code}`))
                    })
                })

            await Promise.all([
                runChildProcess(`
                    import { recordCodexRateLimitsUpdate } from './src/agent/agentQuotas.ts';
                    recordCodexRateLimitsUpdate({ rateLimits: {} });
                `),
                runChildProcess(`
                    import { recordAgyTier } from './src/agent/agentQuotas.ts';
                    recordAgyTier('Google AI Ultra');
                `),
                runChildProcess(`
                    import { recordClaudeRateLimitEvent } from './src/agent/agentQuotas.ts';
                    recordClaudeRateLimitEvent({
                        status: 'allowed',
                        rateLimitType: 'five_hour',
                        utilization: 0.25,
                        resetsAt: ${resetSec}
                    }, process.env, 'userA@example.com');
                `),
                runChildProcess(`
                    import { recordClaudeRateLimitEvent } from './src/agent/agentQuotas.ts';
                    recordClaudeRateLimitEvent({
                        status: 'allowed',
                        rateLimitType: 'seven_day',
                        utilization: 0.5,
                        resetsAt: ${resetSec + 86400}
                    }, process.env, 'userA@example.com');
                `)
            ])

            _resetAgentQuotasCacheForTests()
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Max' },
                statusRows: new Map([['Email', 'userA@example.com']])
            }))

            const claude = await probeClaudeQuota(env)
            expect(claude.buckets.map((b) => ({ id: b.id, usedPercent: b.usedPercent }))).toEqual([
                { id: 'claude-five_hour', usedPercent: 25 },
                { id: 'claude-seven_day', usedPercent: 50 }
            ])
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('marks Claude window as exhausted when a rejected rate_limit_event omits utilization after a warning', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-rejected-quota-'))
        try {
            const env = { HAPI_HOME: hapiHome }
            const resetSec = Math.floor(Date.now() / 1000) + 3600

            recordClaudeRateLimitEvent({
                status: 'allowed_warning',
                rateLimitType: 'five_hour',
                utilization: 0.85,
                resetsAt: resetSec
            }, env, 'userA@example.com')

            recordClaudeRateLimitEvent({
                status: 'rejected',
                rateLimitType: 'five_hour',
                resetsAt: resetSec
            }, env, 'userA@example.com')

            _resetAgentQuotasCacheForTests()
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Max' },
                statusRows: new Map([['Email', 'userA@example.com']])
            }))

            const claude = await probeClaudeQuota(env)
            expect(claude.buckets).toEqual([
                {
                    id: 'claude-five_hour',
                    label: '5h window',
                    group: null,
                    window: '5h',
                    usedPercent: 100,
                    remainingPercent: 0,
                    resetsAt: resetSec * 1000
                }
            ])
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('bounds a stalled Codex initialization within probeTimeoutMs while preserving other provider results', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-stalled-codex-'))
        try {
            const env = { HAPI_HOME: hapiHome }
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'codex' || agent === 'claude'
            }))
            vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue(undefined)
            vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockImplementation(
                () => new Promise(() => { /* never resolves */ })
            )
            vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockResolvedValue(undefined)

            _setClaudeStatusProbeForTests(async () => ({
                account: { email: 'userA@example.com', subscriptionType: 'Claude Max' },
                statusRows: new Map([
                    ['Email', 'userA@example.com'],
                    ['Login method', 'Claude Max Account']
                ])
            }))

            const started = Date.now()
            const response = await getAgentQuotasResponse({
                env,
                refresh: true,
                probeTimeoutMs: 60
            })
            const elapsed = Date.now() - started

            expect(elapsed).toBeLessThan(1500)
            const codex = response.accounts.find((a) => a.agent === 'codex')
            const claude = response.accounts.find((a) => a.agent === 'claude')
            expect(codex?.status).toBe('error')
            expect(codex?.note).toContain('timed out')
            expect(claude?.status).toBe('ok')
            expect(claude?.accountLabel).toBe('userA@example.com')
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('preserves credential isolation across two distinct OAuth tokens when initialize returns only tokenSource through getAccountIdentity and updateAccountIdentity', async () => {
        const hapiHome = mkdtempSync(join(tmpdir(), 'hapi-token-source-isolation-'))
        try {
            const resetSec = Math.floor(Date.now() / 1000) + 3600

            const runTokenSession = (token: string, utilization: number) => {
                const script = `
                    import { Writable } from 'node:stream';
                    import { Query } from './src/claude/sdk/query.ts';
                    import { SDKToLogConverter } from './src/claude/utils/sdkToLogConverter.ts';

                    const converter = new SDKToLogConverter({
                        sessionId: 'session-${utilization}',
                        cwd: process.cwd()
                    });
                    const fakeQuery = Object.create(Query.prototype);
                    fakeQuery.childStdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
                    fakeQuery.request = async () => ({
                        response: {
                            account: {
                                tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
                                apiProvider: 'firstParty'
                            }
                        }
                    });
                    const identity = await fakeQuery.getAccountIdentity();
                    converter.updateAccountIdentity(identity);
                    converter.convert({
                        type: 'rate_limit_event',
                        rate_limit_info: {
                            status: 'allowed',
                            rateLimitType: 'five_hour',
                            utilization: ${utilization},
                            resetsAt: ${resetSec}
                        }
                    });
                `
                return spawnSync('bun', ['-e', script], {
                    cwd: process.cwd(),
                    env: {
                        PATH: process.env.PATH,
                        HOME: hapiHome,
                        HAPI_HOME: hapiHome,
                        CLAUDE_CODE_OAUTH_TOKEN: token
                    },
                    encoding: 'utf8'
                })
            }

            expect(runTokenSession('oauth-token-alpha', 0.3).status).toBe(0)
            expect(runTokenSession('oauth-token-beta', 0.85).status).toBe(0)

            _resetAgentQuotasCacheForTests()
            vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
                agent,
                available: agent === 'claude'
            }))
            _setClaudeStatusProbeForTests(async () => ({
                account: {
                    tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
                    subscriptionType: 'Claude Max'
                },
                statusRows: new Map([
                    ['Login method', 'Claude Max Account'],
                    ['Auth token', 'CLAUDE_CODE_OAUTH_TOKEN']
                ])
            }))

            const alphaQuota = await probeClaudeQuota({
                HOME: hapiHome,
                HAPI_HOME: hapiHome,
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-alpha'
            })
            expect(alphaQuota.buckets).toHaveLength(1)
            expect(alphaQuota.buckets[0]?.usedPercent).toBe(30)

            const betaQuota = await probeClaudeQuota({
                HOME: hapiHome,
                HAPI_HOME: hapiHome,
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-beta'
            })
            expect(betaQuota.buckets).toHaveLength(1)
            expect(betaQuota.buckets[0]?.usedPercent).toBe(85)

            const gammaQuota = await probeClaudeQuota({
                HOME: hapiHome,
                HAPI_HOME: hapiHome,
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-gamma'
            })
            expect(gammaQuota.buckets).toEqual([])
        } finally {
            rmSync(hapiHome, { recursive: true, force: true })
        }
    })

    it('reports failed Codex account and rateLimits reads with status error while preserving partial account metadata', async () => {
        vi.spyOn(agentAvailability, 'getAgentAvailability').mockImplementation((agent) => ({
            agent,
            available: agent === 'codex'
        }))
        vi.spyOn(CodexAppServerClient.prototype, 'connect').mockResolvedValue(undefined)
        vi.spyOn(CodexAppServerClient.prototype, 'initialize').mockResolvedValue({})
        vi.spyOn(CodexAppServerClient.prototype, 'disconnect').mockResolvedValue(undefined)

        // 1. account/read succeeds, account/rateLimits/read rejects
        vi.spyOn(CodexAppServerClient.prototype, 'readAccount').mockResolvedValueOnce({
            account: {
                type: 'chatgpt',
                email: 'user@example.com',
                planType: 'pro'
            }
        })
        vi.spyOn(CodexAppServerClient.prototype, 'readRateLimits').mockRejectedValueOnce(
            new Error('Rate limits endpoint unavailable')
        )

        const rateLimitFailed = await probeCodexQuota({})
        expect(rateLimitFailed.status).toBe('error')
        expect(rateLimitFailed.accountLabel).toBe('user@example.com')
        expect(rateLimitFailed.planLabel).toBe('Pro')
        expect(rateLimitFailed.buckets).toEqual([])
        expect(rateLimitFailed.note).toBe('Rate limits endpoint unavailable')

        // 2. account/read rejects, account/rateLimits/read succeeds
        vi.spyOn(CodexAppServerClient.prototype, 'readAccount').mockRejectedValueOnce(
            new Error('Account endpoint unavailable')
        )
        vi.spyOn(CodexAppServerClient.prototype, 'readRateLimits').mockResolvedValueOnce({
            rateLimits: {
                planType: 'plus',
                primary: {
                    usedPercent: 35,
                    windowDurationMins: 300,
                    resetsAt: 1775559600
                }
            }
        })

        const accountFailed = await probeCodexQuota({})
        expect(accountFailed.status).toBe('error')
        expect(accountFailed.planLabel).toBe('Plus')
        expect(accountFailed.buckets).toHaveLength(1)
        expect(accountFailed.buckets[0]?.usedPercent).toBe(35)
        expect(accountFailed.note).toBe('Account endpoint unavailable')

        // 3. Both reads reject
        vi.spyOn(CodexAppServerClient.prototype, 'readAccount').mockRejectedValueOnce(
            new Error('Account RPC failed')
        )
        vi.spyOn(CodexAppServerClient.prototype, 'readRateLimits').mockRejectedValueOnce(
            new Error('RateLimits RPC failed')
        )

        const bothFailed = await probeCodexQuota({})
        expect(bothFailed.status).toBe('error')
        expect(bothFailed.buckets).toEqual([])
        expect(bothFailed.note).toBe('RateLimits RPC failed')
    })
})
