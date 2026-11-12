import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import type { AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'
import {
    SessionJobError,
    SESSION_JOB_REMAINING_ZERO_HINT,
    clearSessionJob,
    exitCodeForSessionJobError,
    formatSessionJobNotFoundHint,
    listSessionJobs,
    setSessionJob,
    updateSessionJob
} from '@/modules/sessionJob/sessionJob'
import { formatJobLine } from '@/modules/sessionJob/formatJobLine'
import { runSessionJob } from '@/modules/sessionJob/runSessionJob'
import {
    assertCreateProgressMode,
    assertNumericSleepUsesUntil,
    commandLooksLikeNumericSleep,
    type JobProgressMode,
    parseUntilTimestamp,
    stampUntilProgress
} from '@/modules/sessionJob/jobProgressMode'
import type { CommandDefinition } from './types'

export { formatJobLine, terminalText } from '@/modules/sessionJob/formatJobLine'

export type ParsedJobArgs = {
    help: boolean
    action?: 'set' | 'update' | 'clear' | 'list' | 'run'
    sessionIdPrefix?: string
    jobKey?: string
    label?: string
    status?: 'running' | 'completed' | 'failed'
    progress?: JobProgressMode
    untilMs?: number
    done?: number | null
    total?: number | null
    remaining?: number | null
    unit?: string | null
    detail?: string | null
    startedAt?: number
    heartbeatSec?: number
    runId?: string
    expectedRunId?: string
    wakeOnTerminal?: boolean
    wakePrompt?: string
    command?: string[]
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi job')} - Attach long-running work to a HAPI session (tiann/hapi#1404)

${chalk.bold('When to use:')}
  Work that outlives the agent (batch / long scripts / external daemons)
  while the session may be idle. Not thinking progress or in-agent background tools.

${chalk.bold('Agent contract:')}
  Prefer ${chalk.bold('hapi job run')} — it heartbeats for you and marks completed/failed on exit.
  An idle agent cannot heartbeat; set-once jobs go amber after ~15m.
  ${chalk.bold('run/set require --progress')} unknown|fraction|until (explicit affordance).
  unknown → indeterminate stripes (no counts). fraction → remaining+total or done+total.
  until → --until <ISO|epoch>; remaining/total derived (job run heartbeats re-stamp remaining).
  Fraction without a continuous updater freezes under heartbeats — keep
  ${chalk.bold('job update')}ing done/remaining (or use --progress unknown).
  Numeric ${chalk.bold('sleep N')} requires ${chalk.bold('--progress until')}.
  Never invent a fake percent.
  Do not wrap hapi-restart-hub / stack-switch in job run (hub down → zombie running meter).

${chalk.bold('Usage:')}
  hapi job run <session> <job-key> --label <text> --progress unknown|fraction|until […] -- <cmd>…
  hapi job set <session> <job-key> --label <text> --progress unknown|fraction|until […]
  hapi job update <session> <job-key> [--expected-run-id UUID] [--remaining N] [--done N] [--total N] [--status running|completed|failed] [--wake-on-terminal] [--wake-prompt <text>] [--detail ...]
                       [--clear-remaining|--clear-done|--clear-total|--clear-unit|--clear-detail]
  hapi job clear <session> <job-key> [--expected-run-id UUID]
  hapi job list <session>

${chalk.bold('Wake on terminal (tiann/hapi#1489, default off):')}
  --wake-on-terminal   When the job hits completed/failed, hub resumes the owning
                       session and posts a prompt so an idle agent can continue.
  --wake-prompt TEXT   Optional prescription appended to the wake message.

${chalk.bold('Progress UI (--progress):')}
  unknown             → "running · 2h" + subtle indeterminate striped bar (no %)
  fraction            → remaining+total or done+total → fill bar
  until               → determinate countdown from --until (unit s)
  elapsed always from startedAt (wall clock) — never an ETA field
  --clear-remaining   → drop leftover meter so done/total can take over (PATCH null)

${chalk.bold('startedAt / elapsed:')}
  Prefer ${chalk.bold('update')} for heartbeats/progress so the clock is never wiped.
  PATCH rejects startedAt. PUT/set without --started-at keeps the existing clock.
  Late attach or wrong clock: ${chalk.bold('set --started-at <epoch-ms>')} (explicit PUT),
  or clear then set with --started-at (works on older hubs that ignored PUT corrections).
  Mid-window countdown re-attach: ${chalk.bold('run --progress until --until … --started-at <window-start-ms>')}
  so heartbeat total stays until−start (not "time left from this restart").
  Manual babysitter wrappers: mint one UUID per run (${chalk.bold('set --run-id <uuid>')}),
  then pass the same value on every heartbeat (${chalk.bold('update --expected-run-id <uuid>')})
  and on clear (${chalk.bold('clear --expected-run-id <uuid>')}) so a key-reuse cannot
  steal the older wrapper's PATCHes or DELETE the newer run.

${chalk.bold('Notes:')}
  Hub-persisted. Prefer "$HAPI_SESSION_ID" when it matches the operator chat row
  (/sessions/<id> in the web URL). Remote Cursor runner may export a worker-row id —
  pass that URL uuid explicitly (see docs/guide/session-jobs.md).
  Needs a hub/CLI that includes the job subcommand (soup / feat build — not every npm release).
  Job key: 1-128 chars, alnum / . _ -
  Session lookup prefers exact id; prefix scan is the 500 most-recently-updated sessions.
  Docs: docs/guide/session-jobs.md

${chalk.bold('Env:')}
  HAPI_API_URL / CLI_API_TOKEN (or ~/.hapi/settings.json via \`hapi auth login\`)
`)
}

function parseOptionalNumber(flag: string, value: string | undefined): number {
    if (value === undefined) {
        throw new SessionJobError('bad_args', `${flag} requires a number`)
    }
    const n = Number(value)
    if (!Number.isFinite(n)) {
        throw new SessionJobError('bad_args', `${flag} must be a number`)
    }
    return n
}

export function parseJobArgs(args: string[]): ParsedJobArgs {
    const result: ParsedJobArgs = { help: false }
    const dashDash = args.indexOf('--')
    const flagArgs = dashDash >= 0 ? args.slice(0, dashDash) : args
    if (dashDash >= 0) {
        result.command = args.slice(dashDash + 1)
    }

    for (let i = 0; i < flagArgs.length; i++) {
        const arg = flagArgs[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--label') {
            result.label = flagArgs[++i]
            if (!result.label) throw new SessionJobError('bad_args', '--label requires a value')
            continue
        }
        if (arg.startsWith('--label=')) {
            result.label = arg.slice('--label='.length)
            continue
        }
        if (arg === '--status') {
            const value = flagArgs[++i]
            if (value !== 'running' && value !== 'completed' && value !== 'failed') {
                throw new SessionJobError('bad_args', '--status must be running|completed|failed')
            }
            result.status = value
            continue
        }
        if (arg.startsWith('--status=')) {
            const value = arg.slice('--status='.length)
            if (value !== 'running' && value !== 'completed' && value !== 'failed') {
                throw new SessionJobError('bad_args', '--status must be running|completed|failed')
            }
            result.status = value
            continue
        }
        if (arg === '--done') {
            result.done = parseOptionalNumber('--done', flagArgs[++i])
            continue
        }
        if (arg.startsWith('--done=')) {
            result.done = parseOptionalNumber('--done', arg.slice('--done='.length))
            continue
        }
        if (arg === '--total') {
            result.total = parseOptionalNumber('--total', flagArgs[++i])
            continue
        }
        if (arg.startsWith('--total=')) {
            result.total = parseOptionalNumber('--total', arg.slice('--total='.length))
            continue
        }
        if (arg === '--remaining') {
            result.remaining = parseOptionalNumber('--remaining', flagArgs[++i])
            continue
        }
        if (arg.startsWith('--remaining=')) {
            result.remaining = parseOptionalNumber('--remaining', arg.slice('--remaining='.length))
            continue
        }
        if (arg === '--unit') {
            result.unit = flagArgs[++i]
            if (!result.unit) throw new SessionJobError('bad_args', '--unit requires a value')
            continue
        }
        if (arg.startsWith('--unit=')) {
            result.unit = arg.slice('--unit='.length)
            continue
        }
        if (arg === '--detail') {
            result.detail = flagArgs[++i]
            if (result.detail === undefined) throw new SessionJobError('bad_args', '--detail requires a value')
            continue
        }
        if (arg.startsWith('--detail=')) {
            result.detail = arg.slice('--detail='.length)
            continue
        }
        if (arg === '--heartbeat-sec') {
            result.heartbeatSec = parseOptionalNumber('--heartbeat-sec', flagArgs[++i])
            continue
        }
        if (arg.startsWith('--heartbeat-sec=')) {
            result.heartbeatSec = parseOptionalNumber('--heartbeat-sec', arg.slice('--heartbeat-sec='.length))
            continue
        }
        if (arg === '--started-at') {
            result.startedAt = parseOptionalNumber('--started-at', flagArgs[++i])
            continue
        }
        if (arg.startsWith('--started-at=')) {
            result.startedAt = parseOptionalNumber('--started-at', arg.slice('--started-at='.length))
            continue
        }
        if (arg === '--clear-remaining') {
            result.remaining = null
            continue
        }
        if (arg === '--clear-done') {
            result.done = null
            continue
        }
        if (arg === '--clear-total') {
            result.total = null
            continue
        }
        if (arg === '--clear-unit') {
            result.unit = null
            continue
        }
        if (arg === '--clear-detail') {
            result.detail = null
            continue
        }
        if (arg === '--run-id') {
            result.runId = flagArgs[++i]
            if (!result.runId) throw new SessionJobError('bad_args', '--run-id requires a value')
            continue
        }
        if (arg.startsWith('--run-id=')) {
            result.runId = arg.slice('--run-id='.length)
            if (!result.runId) throw new SessionJobError('bad_args', '--run-id requires a value')
            continue
        }
        if (arg === '--expected-run-id') {
            result.expectedRunId = flagArgs[++i]
            if (!result.expectedRunId) {
                throw new SessionJobError('bad_args', '--expected-run-id requires a value')
            }
            continue
        }
        if (arg.startsWith('--expected-run-id=')) {
            result.expectedRunId = arg.slice('--expected-run-id='.length)
            if (!result.expectedRunId) {
                throw new SessionJobError('bad_args', '--expected-run-id requires a value')
            }
            continue
        }
        if (arg === '--wake-on-terminal') {
            result.wakeOnTerminal = true
            continue
        }
        if (arg === '--wake-prompt') {
            result.wakePrompt = flagArgs[++i]
            if (result.wakePrompt === undefined) {
                throw new SessionJobError('bad_args', '--wake-prompt requires a value')
            }
            continue
        }
        if (arg.startsWith('--wake-prompt=')) {
            result.wakePrompt = arg.slice('--wake-prompt='.length)
            continue
        }
        if (arg === '--progress') {
            const value = flagArgs[++i]
            if (value !== 'unknown' && value !== 'fraction' && value !== 'until') {
                throw new SessionJobError('bad_args', '--progress must be unknown|fraction|until')
            }
            result.progress = value
            continue
        }
        if (arg.startsWith('--progress=')) {
            const value = arg.slice('--progress='.length)
            if (value !== 'unknown' && value !== 'fraction' && value !== 'until') {
                throw new SessionJobError('bad_args', '--progress must be unknown|fraction|until')
            }
            result.progress = value
            continue
        }
        if (arg === '--until') {
            const value = flagArgs[++i]
            if (value === undefined) {
                throw new SessionJobError('bad_args', '--until requires a value')
            }
            result.untilMs = parseUntilTimestamp(value)
            continue
        }
        if (arg.startsWith('--until=')) {
            result.untilMs = parseUntilTimestamp(arg.slice('--until='.length))
            continue
        }
        if (arg.startsWith('-')) {
            throw new SessionJobError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.action) {
            if (
                arg !== 'set'
                && arg !== 'update'
                && arg !== 'clear'
                && arg !== 'list'
                && arg !== 'run'
            ) {
                throw new SessionJobError('bad_args', `unknown action '${arg}' (set|update|clear|list|run)`)
            }
            result.action = arg
            continue
        }
        if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
            continue
        }
        if (!result.jobKey && result.action !== 'list') {
            result.jobKey = arg
            continue
        }
        throw new SessionJobError('bad_args', `unexpected arg: ${arg}`)
    }

    if (result.startedAt !== undefined && result.action !== undefined) {
        if (result.action === 'set') {
            // ok — correct historical clock / window start
        } else if (result.action === 'run' && result.progress === 'until') {
            // ok — mid-window countdown: heartbeats keep total = until - startedAt
        } else if (result.action === 'run') {
            throw new SessionJobError(
                'bad_args',
                '--started-at on job run is only valid with --progress until '
                + '(pass the window start so total stays honest across re-attach)'
            )
        } else {
            throw new SessionJobError(
                'bad_args',
                '--started-at is only valid with job set, or job run --progress until'
            )
        }
    }

    if (
        result.heartbeatSec !== undefined
        && result.action !== undefined
        && result.action !== 'run'
    ) {
        throw new SessionJobError('bad_args', '--heartbeat-sec is only valid with job run')
    }

    const clearUsed =
        result.done === null
        || result.total === null
        || result.remaining === null
        || result.unit === null
        || result.detail === null
    if (clearUsed && result.action !== undefined && result.action !== 'update') {
        throw new SessionJobError('bad_args', '--clear-* flags are only valid with job update')
    }
    if (result.runId !== undefined && result.action !== undefined && result.action !== 'set') {
        throw new SessionJobError('bad_args', '--run-id is only valid with job set')
    }
    if (
        result.expectedRunId !== undefined
        && result.action !== undefined
        && result.action !== 'update'
        && result.action !== 'clear'
    ) {
        throw new SessionJobError('bad_args', '--expected-run-id is only valid with job update or clear')
    }

    const mutationFieldsUsed = [
        result.label,
        result.status,
        result.done,
        result.total,
        result.remaining,
        result.unit,
        result.detail
    ].some((value) => value !== undefined)

    if (result.action === 'list' && mutationFieldsUsed) {
        throw new SessionJobError('bad_args', 'job list does not accept mutation flags')
    }
    if (result.action === 'clear' && mutationFieldsUsed) {
        throw new SessionJobError('bad_args', 'job clear only accepts --expected-run-id')
    }
    if (result.action === 'run' && result.status !== undefined) {
        throw new SessionJobError('bad_args', '--status is not valid with job run')
    }

    if (
        result.command !== undefined
        && result.action !== undefined
        && result.action !== 'run'
    ) {
        throw new SessionJobError('bad_args', '-- <cmd> is only valid with job run')
    }

    if (
        (result.progress !== undefined || result.untilMs !== undefined)
        && result.action !== undefined
        && result.action !== 'run'
        && result.action !== 'set'
    ) {
        throw new SessionJobError('bad_args', '--progress/--until are only valid with job run or set')
    }

    if (result.action === 'run' || result.action === 'set') {
        // Auto-infer until mode when running `sleep N` without explicit --progress or --until
        if (
            result.action === 'run'
            && result.command
            && commandLooksLikeNumericSleep(result.command)
            && result.progress === undefined
            && result.untilMs === undefined
        ) {
            const sleepSec = Number(result.command[1]!.trim())
            result.progress = 'until'
            result.untilMs = Date.now() + sleepSec * 1000
        }

        assertCreateProgressMode(result.action, {
            progress: result.progress,
            untilMs: result.untilMs,
            done: result.done,
            total: result.total,
            remaining: result.remaining
        })
        if (result.progress === 'until' && result.untilMs !== undefined) {
            const startedAt = result.startedAt ?? Date.now()
            const stamped = stampUntilProgress(result.untilMs, Date.now(), startedAt)
            result.remaining = stamped.remaining
            result.total = stamped.total
            result.unit = result.unit ?? stamped.unit
        }
        if (result.action === 'run' && result.command) {
            assertNumericSleepUsesUntil(result.progress!, result.command)
        }
    }

    return result
}

function formatCliJobLine(job: {
    key: string
    label: string
    status: string
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
    runId?: string
    heartbeatAt: number
    startedAt: number
}): string {
    return formatJobLine(job, { includeTiming: true })
}

export async function handleJobCommand(args: string[]): Promise<void> {
    const parsed = parseJobArgs(args)
    if (parsed.help || !parsed.action) {
        showHelp()
        if (!parsed.action && !parsed.help) {
            throw new SessionJobError('bad_args', 'missing action; usage: hapi job set|update|clear|list|run ...')
        }
        return
    }

    await initializeToken()

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new SessionJobError('bad_args', 'missing session id')
    }

    if (parsed.action === 'list') {
        const result = await listSessionJobs({ sessionIdPrefix: parsed.sessionIdPrefix })
        console.log(`session ${result.sessionId}`)
        if (result.jobs.length === 0) {
            console.log('(no jobs)')
            return
        }
        for (const job of result.jobs) {
            const mark = result.primary?.key === job.key ? '*' : ' '
            console.log(`${mark} ${formatCliJobLine(job)}`)
        }
        return
    }

    if (!parsed.jobKey) {
        throw new SessionJobError('bad_args', 'missing job key')
    }

    if (parsed.action === 'clear') {
        const result = await clearSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey,
            ...(parsed.expectedRunId !== undefined
                ? { expectedRunId: parsed.expectedRunId }
                : {})
        })
        console.log(`cleared ${parsed.jobKey} on ${result.sessionId}`)
        return
    }

    if (parsed.action === 'set') {
        if (!parsed.label) {
            throw new SessionJobError('bad_args', 'set requires --label')
        }
        if (parsed.startedAt !== undefined && !Number.isFinite(parsed.startedAt)) {
            throw new SessionJobError('bad_args', '--started-at must be epoch milliseconds')
        }
        // --progress already asserted + until stamped in parseJobArgs
        const body: AttachedJobUpsert = {
            label: parsed.label,
            status: parsed.status ?? 'running',
            ...(typeof parsed.done === 'number' ? { done: parsed.done } : {}),
            ...(typeof parsed.total === 'number' ? { total: parsed.total } : {}),
            ...(typeof parsed.remaining === 'number' ? { remaining: parsed.remaining } : {}),
            ...(typeof parsed.unit === 'string' ? { unit: parsed.unit } : {}),
            ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
            ...(parsed.startedAt !== undefined ? { startedAt: parsed.startedAt } : {}),
            ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
            ...(parsed.wakeOnTerminal !== undefined ? { wakeOnTerminal: parsed.wakeOnTerminal } : {}),
            ...(parsed.wakePrompt !== undefined ? { wakePrompt: parsed.wakePrompt } : {})
        }
        const result = await setSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey,
            body
        })
        console.log(`set ${formatCliJobLine(result.job)}`)
        return
    }

    if (parsed.action === 'run') {
        if (!parsed.label) {
            throw new SessionJobError('bad_args', 'run requires --label')
        }
        if (!parsed.command || parsed.command.length === 0) {
            throw new SessionJobError('bad_args', 'run requires a command after --')
        }
        if (parsed.startedAt !== undefined && !Number.isFinite(parsed.startedAt)) {
            throw new SessionJobError('bad_args', '--started-at must be epoch milliseconds')
        }
        const exitCode = await runSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey,
            label: parsed.label,
            command: parsed.command,
            ...(parsed.heartbeatSec !== undefined
                ? { heartbeatMs: Math.max(5, parsed.heartbeatSec) * 1000 }
                : {}),
            ...(typeof parsed.done === 'number' ? { done: parsed.done } : {}),
            ...(typeof parsed.total === 'number' ? { total: parsed.total } : {}),
            ...(typeof parsed.remaining === 'number' ? { remaining: parsed.remaining } : {}),
            ...(typeof parsed.unit === 'string' ? { unit: parsed.unit } : {}),
            ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
            ...(parsed.untilMs !== undefined ? { untilMs: parsed.untilMs } : {}),
            ...(parsed.startedAt !== undefined ? { startedAtMs: parsed.startedAt } : {}),
            ...(parsed.wakeOnTerminal !== undefined ? { wakeOnTerminal: parsed.wakeOnTerminal } : {}),
            ...(parsed.wakePrompt !== undefined ? { wakePrompt: parsed.wakePrompt } : {})
        })
        if (exitCode !== 0) {
            process.exitCode = exitCode
        }
        console.log(`run finished exit=${exitCode} job=${parsed.jobKey}`)
        return
    }

    // update
    const body: AttachedJobPatch = {
        ...(parsed.label !== undefined ? { label: parsed.label } : {}),
        ...(parsed.status !== undefined ? { status: parsed.status } : {}),
        ...(parsed.done !== undefined ? { done: parsed.done } : {}),
        ...(parsed.total !== undefined ? { total: parsed.total } : {}),
        ...(parsed.remaining !== undefined ? { remaining: parsed.remaining } : {}),
        ...(parsed.unit !== undefined ? { unit: parsed.unit } : {}),
        ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
        ...(parsed.expectedRunId !== undefined ? { expectedRunId: parsed.expectedRunId } : {}),
        ...(parsed.wakeOnTerminal !== undefined ? { wakeOnTerminal: parsed.wakeOnTerminal } : {}),
        ...(parsed.wakePrompt !== undefined ? { wakePrompt: parsed.wakePrompt } : {})
    }
    // Empty body is a heartbeat-only update; hub stamps heartbeatAt.
    let result
    try {
        result = await updateSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey,
            body
        })
    } catch (error) {
        if (error instanceof SessionJobError && error.code === 'not_found') {
            throw new SessionJobError('not_found', formatSessionJobNotFoundHint('update'))
        }
        throw error
    }
    console.log(`updated ${formatCliJobLine(result.job)}`)
    if (result.job.status === 'running' && result.job.remaining === 0) {
        console.error(chalk.yellow('hapi job hint:'), SESSION_JOB_REMAINING_ZERO_HINT)
    }
}

export const jobCommand: CommandDefinition = {
    name: 'job',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleJobCommand(commandArgs)
        } catch (error) {
            if (error instanceof SessionJobError) {
                console.error(chalk.red('hapi job:'), error.message)
                process.exit(exitCodeForSessionJobError(error))
            }
            console.error(
                chalk.red('hapi job:'),
                error instanceof Error ? error.message : 'Unknown error'
            )
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
