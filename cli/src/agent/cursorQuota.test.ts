import { afterEach, expect, it, vi } from 'vitest'
import { cursorQuotaBuckets, probeCursorQuota } from './cursorQuota'
import * as availability from './agentAvailability'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps an explicitly unused pool and omits pools that were not reported', () => {
    expect(cursorQuotaBuckets({ billingCycleEnd: '1795800000000', planUsage: { autoPercentUsed: 0, includedSpend: 3, limit: 4 } }))
        .toEqual([
            { id: 'included', label: 'Included plan usage', usedPercent: 75, remainingPercent: 25, resetsAt: 1795800000000 },
            { id: 'auto', label: 'Auto', usedPercent: 0, remainingPercent: 100, resetsAt: 1795800000000 },
        ])
    expect(cursorQuotaBuckets({ planUsage: {} })).toEqual([])
})

it('queries the fixed first-party service and keeps authentication out of returned records', async () => {
    vi.spyOn(availability, 'getAgentAvailability').mockReturnValue({ agent: 'cursor', available: true })
    const fetcher = vi.fn().mockResolvedValue(Response.json({ planUsage: { totalPercentUsed: 18 } }))
    vi.stubGlobal('fetch', fetcher)
    const quota = await probeCursorQuota({ CURSOR_AUTH_TOKEN: 'example-login' }, 500)
    expect(fetcher).toHaveBeenCalledWith('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
        expect.objectContaining({ redirect: 'error', method: 'POST' }))
    expect(quota.status).toBe('ok')
    expect(quota.buckets[0].remainingPercent).toBe(82)
    expect(JSON.stringify(quota)).not.toContain('example-login')
    await probeCursorQuota({ CURSOR_AUTH_TOKEN: 'example-login', CURSOR_API_ENDPOINT: 'https://example.invalid' }, 500)
    expect(fetcher).toHaveBeenCalledTimes(1)
})

it('keeps missing quota and failed login distinct from an unused plan', async () => {
    vi.spyOn(availability, 'getAgentAvailability').mockReturnValue({ agent: 'cursor', available: true })
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ planUsage: { limit: 0 } }))
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    const env = { CURSOR_AUTH_TOKEN: 'example-login' }
    expect(await probeCursorQuota(env, 500)).toMatchObject({ status: 'unavailable', buckets: [] })
    expect(await probeCursorQuota(env, 500)).toMatchObject({ status: 'unauthenticated', buckets: [] })
})
