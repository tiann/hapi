import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import type { AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'
import {
    SessionJobError,
    clearSessionJob,
    exitCodeForSessionJobError,
    listSessionJobs,
    setSessionJob,
    updateSessionJob
} from '@/modules/sessionJob/sessionJob'
import type { CommandDefinition } from './types'

type ParsedJobArgs = {
    help: boolean
    action?: 'set' | 'update' | 'clear' | 'list'
    sessionIdPrefix?: string
    jobKey?: string
    label?: string
    status?: 'running' | 'completed' | 'failed'
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi job')} - Attach long-running work to a HAPI session (tiann/hapi#1404)

${chalk.bold('Usage:')}
  hapi job set <session-id-or-prefix> <job-key> --label <text> [--remaining N] [--done N --total N] [--unit tracks] [--detail ...]
  hapi job update <session-id-or-prefix> <job-key> [--remaining N] [--done N] [--total N] [--status running|completed|failed] [--detail ...]
  hapi job clear <session-id-or-prefix> <job-key>
  hapi job list <session-id-or-prefix>

${chalk.bold('Notes:')}
  Hub-persisted. Works while the agent is idle/offline — not thinking progress.
  Prefer honest remaining/done+total; never invent a fake percent.
  Job key: 1-128 chars, alnum / . _ -

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

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
            continue
        }
        if (arg === '--label') {
            result.label = args[++i]
            if (!result.label) throw new SessionJobError('bad_args', '--label requires a value')
            continue
        }
        if (arg.startsWith('--label=')) {
            result.label = arg.slice('--label='.length)
            continue
        }
        if (arg === '--status') {
            const value = args[++i]
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
            result.done = parseOptionalNumber('--done', args[++i])
            continue
        }
        if (arg.startsWith('--done=')) {
            result.done = parseOptionalNumber('--done', arg.slice('--done='.length))
            continue
        }
        if (arg === '--total') {
            result.total = parseOptionalNumber('--total', args[++i])
            continue
        }
        if (arg.startsWith('--total=')) {
            result.total = parseOptionalNumber('--total', arg.slice('--total='.length))
            continue
        }
        if (arg === '--remaining') {
            result.remaining = parseOptionalNumber('--remaining', args[++i])
            continue
        }
        if (arg.startsWith('--remaining=')) {
            result.remaining = parseOptionalNumber('--remaining', arg.slice('--remaining='.length))
            continue
        }
        if (arg === '--unit') {
            result.unit = args[++i]
            if (!result.unit) throw new SessionJobError('bad_args', '--unit requires a value')
            continue
        }
        if (arg.startsWith('--unit=')) {
            result.unit = arg.slice('--unit='.length)
            continue
        }
        if (arg === '--detail') {
            result.detail = args[++i]
            if (result.detail === undefined) throw new SessionJobError('bad_args', '--detail requires a value')
            continue
        }
        if (arg.startsWith('--detail=')) {
            result.detail = arg.slice('--detail='.length)
            continue
        }
        if (arg.startsWith('-')) {
            throw new SessionJobError('bad_args', `unexpected flag: ${arg}`)
        }
        if (!result.action) {
            if (arg !== 'set' && arg !== 'update' && arg !== 'clear' && arg !== 'list') {
                throw new SessionJobError('bad_args', `unknown action '${arg}' (set|update|clear|list)`)
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

    return result
}

function formatJobLine(job: {
    key: string
    label: string
    status: string
    done?: number
    total?: number
    remaining?: number
    unit?: string
    detail?: string
    heartbeatAt: number
}): string {
    const parts = [`${job.key}`, job.label, job.status]
    if (job.remaining !== undefined) {
        parts.push(`${job.remaining}${job.unit ? ` ${job.unit}` : ''} left`)
    } else if (job.done !== undefined && job.total !== undefined) {
        parts.push(`${job.done}/${job.total}${job.unit ? ` ${job.unit}` : ''}`)
    }
    if (job.detail) parts.push(job.detail)
    const ageSec = Math.max(0, Math.round((Date.now() - job.heartbeatAt) / 1000))
    parts.push(`heartbeat ${ageSec}s ago`)
    return parts.join(' · ')
}

export async function handleJobCommand(args: string[]): Promise<void> {
    const parsed = parseJobArgs(args)
    if (parsed.help || !parsed.action) {
        showHelp()
        if (!parsed.action && !parsed.help) {
            throw new SessionJobError('bad_args', 'missing action; usage: hapi job set|update|clear|list ...')
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
            console.log(`${mark} ${formatJobLine(job)}`)
        }
        return
    }

    if (!parsed.jobKey) {
        throw new SessionJobError('bad_args', 'missing job key')
    }

    if (parsed.action === 'clear') {
        const result = await clearSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey
        })
        console.log(`cleared ${parsed.jobKey} on ${result.sessionId}`)
        return
    }

    if (parsed.action === 'set') {
        if (!parsed.label) {
            throw new SessionJobError('bad_args', 'set requires --label')
        }
        const body: AttachedJobUpsert = {
            label: parsed.label,
            status: parsed.status ?? 'running',
            ...(parsed.done !== undefined ? { done: parsed.done } : {}),
            ...(parsed.total !== undefined ? { total: parsed.total } : {}),
            ...(parsed.remaining !== undefined ? { remaining: parsed.remaining } : {}),
            ...(parsed.unit !== undefined ? { unit: parsed.unit } : {}),
            ...(parsed.detail !== undefined ? { detail: parsed.detail } : {})
        }
        const result = await setSessionJob({
            sessionIdPrefix: parsed.sessionIdPrefix,
            jobKey: parsed.jobKey,
            body
        })
        console.log(`set ${formatJobLine(result.job)}`)
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
        ...(parsed.detail !== undefined ? { detail: parsed.detail } : {})
    }
    if (Object.keys(body).length === 0) {
        throw new SessionJobError('bad_args', 'update requires at least one field')
    }
    const result = await updateSessionJob({
        sessionIdPrefix: parsed.sessionIdPrefix,
        jobKey: parsed.jobKey,
        body
    })
    console.log(`updated ${formatJobLine(result.job)}`)
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
