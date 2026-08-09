/**
 * MCP surface for session-attached jobs (tiann/hapi#1404).
 * Same discovery class as ping_peer / inspect_peer — tool catalog, not docs-only.
 */

import { z } from 'zod'
import type { AttachedJob, AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'
import {
    SessionJobError,
    clearSessionJob,
    listSessionJobs,
    setSessionJob,
    updateSessionJob
} from './sessionJob'

export const SESSION_JOB_TOOL_NAME = 'session_job'

/**
 * Self-contained tool description — agents select by matching intent to this text.
 * Write for selection, not for humans browsing a README.
 */
export const SESSION_JOB_TOOL_DESCRIPTION = [
    'Attach or update a hub-persisted progress meter on THIS HAPI session for work that',
    'OUTLIVES this agent turn (nohup / batch import / rclone / compile / long drain /',
    'external daemon). Own-session only (auto-approved) — not for injecting meters onto',
    'peer sessions (use CLI hapi job for that). The session list shows the meter while',
    'the agent is idle (active:false). Prefer CLI for process-shaped work:',
    'hapi job run "$HAPI_SESSION_ID" <job-key> --label … -- <cmd> (auto-heartbeats).',
    'Manual: action=set BEFORE starting the process, then action=update at least every',
    '~10 minutes from a self-heartbeating wrapper — an idle agent cannot. Prefer honest',
    'remaining or done+total; omit counts when unknown (UI shows "running" + elapsed).',
    'Never invent a percent or ETA. Finish with action=update status=completed|failed',
    'or action=clear. Not for in-agent todos, thinking progress, or short tool calls.',
].join(' ')

export const sessionJobInputSchema: z.ZodTypeAny = z.object({
    action: z.enum(['set', 'update', 'clear', 'list']).describe(
        'set=register/upsert running job; update=heartbeat/progress/status; clear=remove; list=show jobs'
    ),
    jobKey: z.string().trim().min(1).max(128).optional().describe(
        'Stable job key (alnum . _ -). Required for set/update/clear.'
    ),
    label: z.string().trim().min(1).max(200).optional().describe(
        'Short human label for the list chrome. Required for set.'
    ),
    status: z.enum(['running', 'completed', 'failed']).optional().describe(
        'Job status. Default running on set.'
    ),
    done: z.number().nonnegative().optional().describe('Units completed (pair with total when known).'),
    total: z.number().positive().optional().describe('Total units when both ends of a fraction exist.'),
    remaining: z.number().nonnegative().optional().describe('Units left — prefer when operator cares about leftover.'),
    unit: z.string().trim().min(1).max(64).optional().describe('Unit label (tracks, folders, files, …).'),
    detail: z.string().max(500).optional().describe('Stage / current item text (not an ETA).'),
    startedAt: z.number().optional().describe(
        'Epoch ms process start. Only on set/upsert; omit on heartbeats. Correct late attach with explicit value.'
    )
})

export type SessionJobToolArgs = {
    action: 'set' | 'update' | 'clear' | 'list'
    jobKey?: string
    label?: string
    status?: 'running' | 'completed' | 'failed'
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
    startedAt?: number
}

function formatJobLine(job: AttachedJob): string {
    const parts = [`${job.key}`, job.label, job.status]
    if (job.remaining !== undefined) {
        parts.push(`${job.remaining}${job.unit ? ` ${job.unit}` : ''} left`)
    } else if (job.done !== undefined && job.total !== undefined) {
        parts.push(`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ''}`)
    }
    if (job.detail) parts.push(job.detail)
    return parts.join(' · ')
}

export async function handleSessionJobTool(
    args: SessionJobToolArgs,
    defaultSessionId: string
): Promise<{ text: string; isError: boolean }> {
    // Own-session only — sessionId is not in the schema so auto-approve cannot
    // become a silent cross-session write (cold-review pass 3 Major).
    const sessionIdPrefix = (defaultSessionId || process.env.HAPI_SESSION_ID || '').trim()
    if (!sessionIdPrefix) {
        return {
            text: 'own session id required (set HAPI_SESSION_ID / call from a HAPI-wrapped session)',
            isError: true
        }
    }

    try {
        if (args.action === 'list') {
            const result = await listSessionJobs({ sessionIdPrefix })
            if (result.jobs.length === 0) {
                return { text: `session ${result.sessionId}\n(no jobs)`, isError: false }
            }
            const lines = result.jobs.map((job) => {
                const mark = result.primary?.key === job.key ? '*' : ' '
                return `${mark} ${formatJobLine(job)}`
            })
            return { text: `session ${result.sessionId}\n${lines.join('\n')}`, isError: false }
        }

        if (!args.jobKey?.trim()) {
            return { text: 'jobKey is required for set/update/clear', isError: true }
        }
        const jobKey = args.jobKey.trim()

        if (args.action === 'clear') {
            const result = await clearSessionJob({ sessionIdPrefix, jobKey })
            return { text: `cleared ${jobKey} on ${result.sessionId}`, isError: false }
        }

        if (args.action === 'set') {
            if (!args.label?.trim()) {
                return { text: 'label is required for action=set', isError: true }
            }
            const body: AttachedJobUpsert = {
                label: args.label.trim(),
                status: args.status ?? 'running',
                ...(args.done !== undefined ? { done: args.done } : {}),
                ...(args.total !== undefined ? { total: args.total } : {}),
                ...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
                ...(args.unit !== undefined ? { unit: args.unit } : {}),
                ...(args.detail !== undefined ? { detail: args.detail } : {}),
                ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {})
            }
            const result = await setSessionJob({ sessionIdPrefix, jobKey, body })
            return {
                text: `set ${formatJobLine(result.job)} on ${result.sessionId}`,
                isError: false
            }
        }

        // update
        const body: AttachedJobPatch = {
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.done !== undefined ? { done: args.done } : {}),
            ...(args.total !== undefined ? { total: args.total } : {}),
            ...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
            ...(args.unit !== undefined ? { unit: args.unit } : {}),
            ...(args.detail !== undefined ? { detail: args.detail } : {})
        }
        // Empty body is a heartbeat-only update; hub stamps heartbeatAt.
        const result = await updateSessionJob({ sessionIdPrefix, jobKey, body })
        return {
            text: `updated ${formatJobLine(result.job)} on ${result.sessionId}`,
            isError: false
        }
    } catch (error) {
        const message = error instanceof SessionJobError
            ? error.message
            : error instanceof Error
                ? error.message
                : String(error)
        return { text: `session_job failed: ${message}`, isError: true }
    }
}
