import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { initializeToken, TokenInitializationError } from '@/ui/tokenInit'
import { PingPeerError, exitCodeForPingPeerError, pingPeer } from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

type ParsedPingPeerArgs = {
    help: boolean
    json: boolean
    sessionId?: string
    message?: string
    messageFile?: string
    remitId?: string
    waitActiveSecs?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi ping-peer')} - Send a message to one user-selected HAPI session

${chalk.bold('Usage:')}
  hapi ping-peer <exact-session-id> <message-text>
  hapi ping-peer <exact-session-id> --message-file <path|-> [--remit-id UUID] [--json]

The exact session UUID must come from the user. Prefixes are rejected. Inactive
sessions are resumed before delivery. --json emits stable machine-readable output.
`)
}

export function parsePingPeerArgs(args: string[]): ParsedPingPeerArgs {
    const result: ParsedPingPeerArgs = { help: false, json: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') result.help = true
        else if (arg === '--json') result.json = true
        else if (arg === '--message-file') {
            const value = args[++i]
            if (!value || (value.startsWith('-') && value !== '-')) throw new PingPeerError('bad_args', '--message-file requires a path or -')
            result.messageFile = value
        } else if (arg.startsWith('--message-file=')) {
            result.messageFile = arg.slice('--message-file='.length)
        } else if (arg === '--remit-id') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new PingPeerError('bad_args', '--remit-id requires a UUID')
            result.remitId = value
        } else if (arg.startsWith('--remit-id=')) {
            const value = arg.slice('--remit-id='.length)
            if (!value) throw new PingPeerError('bad_args', '--remit-id requires a UUID')
            result.remitId = value
        } else if (arg === '--wait') {
            const value = args[++i]
            if (!value || value.startsWith('-')) throw new PingPeerError('bad_args', '--wait requires seconds')
            result.waitActiveSecs = Number(value)
        } else if (arg.startsWith('--wait=')) {
            result.waitActiveSecs = Number(arg.slice('--wait='.length))
        } else if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        } else if (!result.sessionId) {
            result.sessionId = arg
        } else if (result.message === undefined) {
            result.message = arg
        } else {
            throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
        }
    }
    if (result.messageFile !== undefined && !result.messageFile) {
        throw new PingPeerError('bad_args', '--message-file requires a path or -')
    }
    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0 || result.waitActiveSecs > 300)) {
        throw new PingPeerError('bad_args', '--wait must be between 1 and 300 seconds')
    }
    return result
}

async function readMessage(parsed: ParsedPingPeerArgs): Promise<string> {
    if (parsed.messageFile !== undefined) {
        if (parsed.message !== undefined) throw new PingPeerError('bad_args', 'provide one message source')
        if (parsed.messageFile === '-') {
            const chunks: Buffer[] = []
            for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            return Buffer.concat(chunks).toString('utf8')
        }
        return await readFile(parsed.messageFile, 'utf8')
    }
    return parsed.message ?? ''
}

function envWaitActiveSecs(): number | undefined {
    const raw = process.env.HAPI_WAIT_ACTIVE_SECS
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0 || value > 300) throw new PingPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be between 1 and 300')
    return value
}

export async function handlePingPeerCommand(args: string[]): Promise<void> {
    const parsed = parsePingPeerArgs(args)
    if (parsed.help) return showHelp()
    if (!parsed.sessionId) throw new PingPeerError('bad_args', 'exact session id is required')
    const message = await readMessage(parsed)
    if (!message) throw new PingPeerError('bad_args', 'message is required')

    const waitActiveSecs = parsed.waitActiveSecs ?? envWaitActiveSecs()
    await initializeToken({ interactive: !parsed.json })
    const result = await pingPeer({
        sessionId: parsed.sessionId,
        message,
        remitId: parsed.remitId,
        waitActiveSecs,
        onProgress: parsed.json ? undefined : (line) => console.log(`hapi ping-peer: ${line}`)
    })
    console.log(parsed.json
        ? JSON.stringify({ ok: true, ...result })
        : chalk.green(`hapi ping-peer: OK - delivered to ${result.sessionId}`))
}

export const pingPeerCommand: CommandDefinition = {
    name: 'ping-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePingPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError || error instanceof TokenInitializationError) {
                const output = commandArgs.includes('--json')
                    ? JSON.stringify({
                        ok: false,
                        ...(error instanceof PingPeerError && error.remitId ? { remitId: error.remitId } : {}),
                        error: { code: error.code, message: error.message }
                    })
                    : `${chalk.red('hapi ping-peer:')} ${error.message}`
                commandArgs.includes('--json') ? console.log(output) : console.error(output)
                process.exit(error instanceof TokenInitializationError ? 2 : exitCodeForPingPeerError(error))
            }
            const output = commandArgs.includes('--json')
                ? JSON.stringify({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'Unknown error' } })
                : `${chalk.red('hapi ping-peer:')} ${error instanceof Error ? error.message : 'Unknown error'}`
            commandArgs.includes('--json') ? console.log(output) : console.error(output)
            process.exit(1)
        }
    }
}
