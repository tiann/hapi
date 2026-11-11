import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentAvailability from './agentAvailability'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import {
    _resetAgentQuotasCacheForTests,
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
        expect(initStep).toEqual({ initDone: true, statusDone: false })
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
        expect(statusStep).toEqual({ initDone: false, statusDone: true })
        expect(Object.fromEntries(target.statusRows.entries())).toEqual({
            'Auth token': 'apiKeyHelper',
            'Anthropic base URL': 'https://any.s6o.org'
        })
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
})
