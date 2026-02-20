import { z } from 'zod'
import { getAuthToken } from '@/api/auth'
import { CliRestartSessionsResponseSchema, type CliRestartSessionsResponse } from '@/api/types'
import { configuration } from '@/configuration'

const restartSessionsBodySchema = z.object({
    sessionIds: z.array(z.string()).optional(),
    machineId: z.string().optional()
})

export async function restartSessionsViaHub(opts: {
    sessionIds?: string[]
    machineId?: string
}): Promise<CliRestartSessionsResponse> {
    const parsedBody = restartSessionsBodySchema.parse({
        sessionIds: opts.sessionIds,
        machineId: opts.machineId
    })

    const response = await fetch(`${configuration.apiUrl}/cli/restart-sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(parsedBody),
        signal: AbortSignal.timeout(60_000)
    })

    if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null
        const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(`Failed to restart sessions via hub: ${message}`)
    }

    const json = await response.json() as unknown
    const parsed = CliRestartSessionsResponseSchema.safeParse(json)
    if (!parsed.success) {
        throw new Error('Invalid /cli/restart-sessions response')
    }

    return parsed.data
}
