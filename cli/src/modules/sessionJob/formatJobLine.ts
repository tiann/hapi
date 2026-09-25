import { stripVTControlCharacters } from 'node:util'

/**
 * Job fields can carry agent- or repo-supplied text. Strip VT/ANSI and remaining
 * C0 controls before printing so CLI stdout and MCP tool results cannot emit
 * OSC clipboard / title escapes into agent or operator terminals.
 */
export function terminalText(value: string): string {
    // stripVT removes ESC-based VT; also scrub C0 + DEL + C1 (incl. 8-bit OSC/ST).
    return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

export type FormatJobLineJob = {
    key: string
    label: string
    status: string
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
    runId?: string
    heartbeatAt?: number
    startedAt?: number
}

export type FormatJobLineOptions = {
    /** CLI list/set/update include wall-clock elapsed + heartbeat age. */
    includeTiming?: boolean
    nowMs?: number
}

export function formatJobLine(
    job: FormatJobLineJob,
    options: FormatJobLineOptions = {}
): string {
    const unit = job.unit ? ` ${terminalText(job.unit)}` : ''
    const parts = [terminalText(job.key), terminalText(job.label), terminalText(job.status)]
    if (job.remaining !== undefined) {
        parts.push(`${job.remaining}${unit} left`)
    } else if (job.done !== undefined && job.total !== undefined) {
        parts.push(`${job.done}/${job.total}${unit}`)
    }
    if (options.includeTiming && job.startedAt !== undefined) {
        const nowMs = options.nowMs ?? Date.now()
        const elapsedSec = Math.max(0, Math.round((nowMs - job.startedAt) / 1000))
        if (elapsedSec < 60) {
            parts.push(`elapsed ${elapsedSec}s`)
        } else if (elapsedSec < 3600) {
            parts.push(`elapsed ${Math.floor(elapsedSec / 60)}m`)
        } else if (elapsedSec < 86400) {
            const h = Math.floor(elapsedSec / 3600)
            const m = Math.floor((elapsedSec % 3600) / 60)
            parts.push(m > 0 ? `elapsed ${h}h ${m}m` : `elapsed ${h}h`)
        } else {
            const d = Math.floor(elapsedSec / 86400)
            const h = Math.floor((elapsedSec % 86400) / 3600)
            parts.push(h > 0 ? `elapsed ${d}d ${h}h` : `elapsed ${d}d`)
        }
    }
    if (job.detail) parts.push(terminalText(job.detail))
    if (job.runId) parts.push(`runId ${terminalText(job.runId)}`)
    if (options.includeTiming && job.heartbeatAt !== undefined) {
        const nowMs = options.nowMs ?? Date.now()
        const ageSec = Math.max(0, Math.round((nowMs - job.heartbeatAt) / 1000))
        parts.push(`heartbeat ${ageSec}s ago`)
    }
    return parts.join(' · ')
}
