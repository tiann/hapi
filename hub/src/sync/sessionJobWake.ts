/**
 * Job-complete → owning-session wake (tiann/hapi#1489).
 *
 * Composes with the same resume → wait-active → sendMessage ordering as
 * `pingPeer`. Does not flip `active` from heartbeats; only the normal resume
 * path may spawn/resume the agent.
 */

import type { AttachedJobStatus } from '@hapi/protocol'

export type JobWakeSnapshot = {
    key: string
    label: string
    status: AttachedJobStatus
    detail?: string
    wakePrompt?: string
    runId?: string
}

export function isTerminalJobStatus(status: AttachedJobStatus): boolean {
    return status === 'completed' || status === 'failed'
}

/** Build the user message that resumes the owning agent. */
export function buildJobTerminalWakePrompt(job: JobWakeSnapshot): string {
    const detail = job.detail?.trim() ? job.detail.trim() : '(none)'
    const lines = [
        `[hapi job] Attached job "${job.key}" (${job.label}) reached status=${job.status}.`,
        `Detail: ${detail}`,
        'Verify the outcome and continue the next batch if appropriate.',
    ]
    if (job.runId) {
        lines.splice(2, 0, `runId: ${job.runId}`)
    }
    const prescription = job.wakePrompt?.trim()
    if (prescription) {
        lines.push('', 'Prescription:', prescription)
    }
    return lines.join('\n')
}

export type WaitUntilActiveDeps = {
    getActive: () => boolean | Promise<boolean>
    sleep: (ms: number) => Promise<void>
    now: () => number
    timeoutMs: number
    pollMs?: number
}

/**
 * Poll until the session is active or timeout.
 * Returns true when active, false on timeout.
 */
export async function waitUntilSessionActive(deps: WaitUntilActiveDeps): Promise<boolean> {
    const pollMs = deps.pollMs ?? 250
    const deadline = deps.now() + deps.timeoutMs
    while (deps.now() < deadline) {
        if (await deps.getActive()) {
            return true
        }
        await deps.sleep(pollMs)
    }
    return await deps.getActive()
}
