/**
 * MCP surface for session-attached jobs (tiann/hapi#1404).
 * Same discovery class as ping_peer / inspect_peer — tool catalog, not docs-only.
 *
 * Hard contract: MCP cannot create a long-lived bar (action=set is refused).
 * Create meters with Shell + `hapi job run` (babysitter). MCP is for
 * update / clear / list after a supervisor or CLI wrapper owns heartbeats.
 */

import { z } from 'zod'
import type { AttachedJob, AttachedJobPatch } from '@hapi/protocol'
import {
    SessionJobError,
    SESSION_JOB_RUN_RECIPE,
    formatSessionJobNotFoundHint,
    clearSessionJob,
    listSessionJobs,
    updateSessionJob
} from './sessionJob'

export const SESSION_JOB_TOOL_NAME = 'session_job'

/** Re-export for tests and steer copy. */
export { SESSION_JOB_RUN_RECIPE }

export const SESSION_JOB_SET_REFUSED_TEXT = [
    'action=set is refused over MCP.',
    'Creating a progress meter for work that outlives this turn requires a babysitter',
    'that heartbeats while the agent is idle — use the Shell tool:',
    SESSION_JOB_RUN_RECIPE,
    'MCP session_job is only for action=update (progress/heartbeat/terminal status),',
    'action=clear, or action=list on a job that job run (or CLI set + self-heartbeat wrapper) already created.',
    'Bare set + nohup freezes the bar when the agent goes idle (wardrobe dogfood).',
].join(' ')

/**
 * Self-contained tool description — agents select by matching intent to this text.
 * Write for selection, not for humans browsing a README.
 */
export const SESSION_JOB_TOOL_DESCRIPTION = [
    'Progress meter on THIS HAPI session for work that OUTLIVES the agent turn.',
    'Own-session only. CRITICAL: do NOT use action=set — it is refused.',
    'To START a long job, use the Shell tool with:',
    SESSION_JOB_RUN_RECIPE,
    '(auto-heartbeats + completed/failed on exit). Idle agents cannot heartbeat.',
    'This MCP tool: action=update (progress/status), action=clear, action=list only.',
    'Prefer honest remaining or done+total; omit counts when unknown.',
    'Never invent a percent or ETA. Not for todos, thinking, or short tool calls.',
].join(' ')

export const sessionJobInputSchema: z.ZodTypeAny = z.object({
    action: z.enum(['set', 'update', 'clear', 'list']).describe(
        'set=REFUSED (use Shell hapi job run). update=heartbeat/progress/status; clear=remove; list=show jobs'
    ),
    jobKey: z.string().trim().min(1).max(128).optional().describe(
        'Stable job key (alnum . _ -). Required for update/clear.'
    ),
    label: z.string().trim().min(1).max(200).optional().describe(
        'Ignored for MCP set (refused). Optional on update.'
    ),
    status: z.enum(['running', 'completed', 'failed']).optional().describe(
        'Job status on update (completed|failed to finish).'
    ),
    done: z.number().nonnegative().nullable().optional().describe(
        'Units completed (pair with total). Pass null to clear a stale done count.'
    ),
    total: z.number().positive().nullable().optional().describe(
        'Total units when both ends of a fraction exist. Pass null to clear.'
    ),
    remaining: z.number().nonnegative().nullable().optional().describe(
        'Units left. Pass null to clear so done/total can take over (web prefers remaining).'
    ),
    unit: z.string().trim().min(1).max(64).nullable().optional().describe(
        'Unit label (tracks, folders, files, …). Pass null to clear.'
    ),
    detail: z.string().max(500).nullable().optional().describe(
        'Stage / current item text (not an ETA). Pass null to clear.'
    ),
    expectedRunId: z.string().min(1).max(64).optional().describe(
        'Run generation fence for update/clear. Required when a manual wrapper stamped runId on set.'
    ),
    startedAt: z.number().optional().describe(
        'Not used over MCP (set is refused). Correct clocks via CLI job set --started-at.'
    )
})

export type SessionJobToolArgs = {
    action: 'set' | 'update' | 'clear' | 'list'
    jobKey?: string
    label?: string
    status?: 'running' | 'completed' | 'failed'
    done?: number | null
    total?: number | null
    remaining?: number | null
    unit?: string | null
    detail?: string | null
    expectedRunId?: string
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
    if (job.runId) parts.push(`runId ${job.runId}`)
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

    // Hard footgun close: MCP must not create orphan meters (set + idle agent).
    if (args.action === 'set') {
        return { text: SESSION_JOB_SET_REFUSED_TEXT, isError: true }
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
            return { text: 'jobKey is required for update/clear', isError: true }
        }
        const jobKey = args.jobKey.trim()

        if (args.startedAt !== undefined) {
            return {
                text: 'startedAt is not valid over MCP (set is refused; use CLI job set --started-at)',
                isError: true
            }
        }

        if (args.action === 'clear') {
            const result = await clearSessionJob({
                sessionIdPrefix,
                jobKey,
                ...(args.expectedRunId !== undefined
                    ? { expectedRunId: args.expectedRunId }
                    : {})
            })
            return { text: `cleared ${jobKey} on ${result.sessionId}`, isError: false }
        }

        // update
        const body: AttachedJobPatch = {
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.done !== undefined ? { done: args.done } : {}),
            ...(args.total !== undefined ? { total: args.total } : {}),
            ...(args.remaining !== undefined ? { remaining: args.remaining } : {}),
            ...(args.unit !== undefined ? { unit: args.unit } : {}),
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
            ...(args.expectedRunId !== undefined
                ? { expectedRunId: args.expectedRunId }
                : {})
        }
        // Empty body is a heartbeat-only update; hub stamps heartbeatAt.
        const result = await updateSessionJob({ sessionIdPrefix, jobKey, body })
        return {
            text: `updated ${formatJobLine(result.job)} on ${result.sessionId}`,
            isError: false
        }
    } catch (error) {
        if (error instanceof SessionJobError && error.code === 'not_found') {
            const action = args.action === 'clear' ? 'clear' : 'update'
            return {
                text: `session_job failed: ${formatSessionJobNotFoundHint(action)}`,
                isError: true
            }
        }
        const message = error instanceof SessionJobError
            ? error.message
            : error instanceof Error
                ? error.message
                : String(error)
        return { text: `session_job failed: ${message}`, isError: true }
    }
}
