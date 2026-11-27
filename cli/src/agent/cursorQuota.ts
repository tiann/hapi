import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AgentQuotaAccount, AgentQuotaBucket } from '@hapi/protocol/apiTypes'
import { getAgentAvailability } from './agentAvailability'

const dashboard = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const usageSchema = z.object({
    billingCycleEnd: z.union([z.string(), z.number()]).optional(),
    planUsage: z.object({
        totalPercentUsed: z.number().nonnegative().optional(),
        autoPercentUsed: z.number().nonnegative().optional(),
        apiPercentUsed: z.number().nonnegative().optional(),
        includedSpend: z.number().nonnegative().optional(),
        limit: z.number().positive().optional().catch(undefined),
    }).optional(),
})

export function cursorQuotaBuckets(response: unknown): AgentQuotaBucket[] {
    const { billingCycleEnd, planUsage } = usageSchema.parse(response)
    if (!planUsage) return []
    const end = Number(billingCycleEnd)
    const resetsAt = Number.isSafeInteger(end) && end > 0 ? end : null
    const total = planUsage.totalPercentUsed ?? (planUsage.includedSpend !== undefined && planUsage.limit
        ? 100 * planUsage.includedSpend / planUsage.limit : undefined)
    const buckets: AgentQuotaBucket[] = []
    for (const [id, label, percent] of [
        ['included', 'Included plan usage', total],
        ['auto', 'Auto', planUsage.autoPercentUsed],
        ['api', 'API', planUsage.apiPercentUsed],
    ] as const) {
        if (percent === undefined) continue
        const usedPercent = Math.min(100, percent)
        buckets.push({ id, label, usedPercent, remainingPercent: 100 - usedPercent, resetsAt })
    }
    return buckets
}

async function readLogin(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
    if (env.CURSOR_AUTH_TOKEN?.trim()) return env.CURSOR_AUTH_TOKEN.trim()
    const home = env.HOME || env.USERPROFILE || homedir()
    if (process.platform === 'darwin') {
        try {
            const result = await promisify(execFile)('/usr/bin/security', [
                'find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w',
            ], { timeout: timeoutMs, maxBuffer: 32_768 })
            if (result.stdout.trim()) return result.stdout.trim()
        } catch { /* Cursor also supports file-backed login. */ }
    }
    const config = process.platform === 'darwin' ? join(home, '.cursor')
        : process.platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor')
        : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cursor')
    try {
        const { accessToken } = JSON.parse(await readFile(join(config, 'auth.json'), 'utf8'))
        return typeof accessToken === 'string' ? accessToken.trim() : undefined
    } catch { return undefined }
}

export async function probeCursorQuota(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<AgentQuotaAccount> {
    const { available } = getAgentAvailability('cursor', env)
    const account: AgentQuotaAccount = { agent: 'cursor', available, status: 'unavailable', updatedAt: Date.now(), buckets: [] }
    if (!available) return account
    if ([env.CURSOR_API_ENDPOINT, env.CURSOR_API_BASE_URL].some(value => value && value.replace(/\/$/, '') !== 'https://api2.cursor.sh')
        || (env.CURSOR_API_KEY && !env.CURSOR_AUTH_TOKEN)) {
        return { ...account, status: 'custom_provider' }
    }
    const token = await readLogin(env, timeoutMs)
    if (!token) return { ...account, status: 'unauthenticated' }
    try {
        const res = await fetch(dashboard, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'connect-protocol-version': '1' },
            body: '{}',
        })
        if (res.status === 401) return { ...account, status: 'unauthenticated' }
        if (!res.ok) return { ...account, status: 'error', note: `Cursor usage service returned HTTP ${res.status}.` }
        const buckets = cursorQuotaBuckets(await res.json())
        return buckets.length ? { ...account, status: 'ok', buckets }
            : { ...account, note: 'Cursor did not report included quota for this plan.' }
    } catch {
        return { ...account, status: 'error', note: 'Could not read quota from the Cursor usage service.' }
    }
}
