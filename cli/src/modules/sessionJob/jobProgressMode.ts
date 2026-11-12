/**
 * Explicit progress mode for job create (run/set).
 * Omission used to default to indeterminate stripes — that hid known-duration
 * countdowns (2026-11-08 dogfood postmortem). Mode must be chosen on purpose.
 */

import { basename } from 'node:path'
import { SessionJobError } from './sessionJob'

export const JOB_PROGRESS_MODES = ['unknown', 'fraction', 'until'] as const
export type JobProgressMode = (typeof JOB_PROGRESS_MODES)[number]

export type ProgressFields = {
    progress?: JobProgressMode
    untilMs?: number
    done?: number | null
    total?: number | null
    remaining?: number | null
    unit?: string | null
}

export function parseUntilTimestamp(raw: string, nowMs: number = Date.now()): number {
    const trimmed = raw.trim()
    if (!trimmed) {
        throw new SessionJobError('bad_args', '--until requires an ISO-8601 timestamp, epoch ms, or duration (+5m, 300s)')
    }
    // Duration: +300s, 300s, +5m, 5m, +1h, 1h, +2d, 2d
    const durationMatch = /^\+?(\d+)(s|m|h|d)$/i.exec(trimmed)
    if (durationMatch && durationMatch[1] && durationMatch[2]) {
        const count = Number(durationMatch[1])
        const unit = durationMatch[2].toLowerCase()
        const multipliers: Record<string, number> = {
            s: 1000,
            m: 60 * 1000,
            h: 3600 * 1000,
            d: 86400 * 1000
        }
        const deltaMs = count * (multipliers[unit] ?? 1000)
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
            throw new SessionJobError('bad_args', '--until duration must be positive')
        }
        return nowMs + deltaMs
    }
    if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed)
        // 10-digit epoch seconds vs 13-digit ms
        const ms = trimmed.length <= 10 ? n * 1000 : n
        if (!Number.isFinite(ms)) {
            throw new SessionJobError('bad_args', '--until must be a finite epoch')
        }
        return ms
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isFinite(parsed)) {
        throw new SessionJobError(
            'bad_args',
            `--until must be ISO-8601 or epoch ms (got ${JSON.stringify(trimmed)})`
        )
    }
    if (parsed <= nowMs) {
        throw new SessionJobError('bad_args', '--until must be in the future')
    }
    return parsed
}

export function assertCreateProgressMode(
    action: 'run' | 'set',
    fields: ProgressFields
): asserts fields is ProgressFields & { progress: JobProgressMode } {
    if (fields.progress === undefined) {
        throw new SessionJobError(
            'bad_args',
            `${action} requires --progress unknown|fraction|until `
            + '(explicit affordance — do not omit; unknown = indeterminate stripes, '
            + 'fraction = remaining+total or done+total, until = --until <iso|epoch>)'
        )
    }
    if (!(JOB_PROGRESS_MODES as readonly string[]).includes(fields.progress)) {
        throw new SessionJobError(
            'bad_args',
            `--progress must be unknown|fraction|until (got ${JSON.stringify(fields.progress)})`
        )
    }

    const hasCount = (v: number | null | undefined): v is number => typeof v === 'number'
    const hasDone = hasCount(fields.done)
    const hasTotal = hasCount(fields.total)
    const hasRemaining = hasCount(fields.remaining)

    if (fields.progress === 'unknown') {
        if (hasDone || hasTotal || hasRemaining || fields.untilMs !== undefined) {
            throw new SessionJobError(
                'bad_args',
                '--progress unknown forbids --done/--total/--remaining/--until '
                + '(claim unknown size explicitly; use fraction or until when you know bounds)'
            )
        }
        return
    }

    if (fields.progress === 'fraction') {
        if (fields.untilMs !== undefined) {
            throw new SessionJobError('bad_args', '--until is only valid with --progress until')
        }
        const remainingPair = hasRemaining && hasTotal
        const donePair = hasDone && hasTotal
        if (!remainingPair && !donePair) {
            throw new SessionJobError(
                'bad_args',
                '--progress fraction requires --remaining N --total M, or --done N --total M'
            )
        }
        return
    }

    // until
    if (fields.untilMs === undefined) {
        throw new SessionJobError(
            'bad_args',
            '--progress until requires --until <ISO-8601 or epoch ms>'
        )
    }
    if (hasDone || hasRemaining || hasTotal) {
        throw new SessionJobError(
            'bad_args',
            '--progress until derives remaining/total from --until; omit --done/--remaining/--total'
        )
    }
}

/** Stamp remaining+total(+unit) for until mode at `nowMs` / optional startedAt. */
export function stampUntilProgress(
    untilMs: number,
    nowMs: number = Date.now(),
    startedAtMs: number = nowMs
): { remaining: number; total: number; unit: string } {
    const totalSec = Math.max(1, Math.ceil((untilMs - startedAtMs) / 1000))
    // Clamp to the window: remaining cannot exceed total (mid-window attach /
    // clock skew) and cannot go negative after the deadline.
    const remainingSec = Math.max(
        0,
        Math.min(totalSec, Math.ceil((untilMs - nowMs) / 1000))
    )
    return {
        remaining: remainingSec,
        total: totalSec,
        unit: 's'
    }
}

/**
 * `sleep <positive-int>` encodes a known wall duration. Bare/alive-only attach
 * was the 2026-11-08 dogfood footgun (stripes / frozen one-shot remaining).
 * `sleep infinity` stays allowed under `--progress unknown`.
 */
export function commandLooksLikeNumericSleep(command: string[]): boolean {
    if (command.length < 2) return false
    const bin = basename(command[0]!)
    if (bin !== 'sleep') return false
    const args = command.slice(1)
    return args.length > 0 && args.every((arg) => /^\d+$/.test(arg.trim()) && Number(arg) > 0)
}

/**
 * Compute the total seconds for a numeric sleep command.
 * Supports multi-argument forms like `sleep 5 60` (65 seconds on GNU sleep).
 */
export function computeNumericSleepSeconds(command: string[]): number | null {
    if (!commandLooksLikeNumericSleep(command)) return null
    return command.slice(1).reduce((sum, arg) => sum + Number(arg.trim()), 0)
}

export function assertNumericSleepUsesUntil(
    progress: JobProgressMode,
    command: string[]
): void {
    if (!commandLooksLikeNumericSleep(command)) return
    if (progress === 'until') return
    throw new SessionJobError(
        'bad_args',
        'numeric `sleep N` is a known-duration countdown — use '
        + '`--progress until --until <ISO|epoch>` (heartbeats keep the bar honest). '
        + '`sleep infinity` is OK with `--progress unknown`; do not encode a deadline '
        + 'as sleep-seconds under unknown/fraction (dogfood postmortem 2026-11-08).'
    )
}
