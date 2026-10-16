import { initializeToken } from '@/ui/tokenInit'
import { archivePeer, PingPeerError, exitCodeForPingPeerError } from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'

export function parseArchivePeerArgs(args: string[]): { help: boolean; self: boolean; sessionIdPrefix?: string } {
    const parsed: { help: boolean; self: boolean; sessionIdPrefix?: string } = { help: false, self: false }
    for (const arg of args) {
        if (arg === '--help' || arg === '-h') parsed.help = true
        else if (arg === '--self') parsed.self = true
        else if (arg.startsWith('-') || parsed.sessionIdPrefix !== undefined) {
            throw new PingPeerError('bad_args', `Unexpected argument: ${arg}`)
        } else parsed.sessionIdPrefix = arg
    }
    if (parsed.self && parsed.sessionIdPrefix !== undefined) {
        throw new PingPeerError('bad_args', 'Choose --self or a target session id, not both')
    }
    return parsed
}

export const archivePeerCommand: CommandDefinition = {
    name: 'archive-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            const args = parseArchivePeerArgs(commandArgs)
            if (args.help) {
                console.log('Usage: hapi archive-peer <session-id-or-prefix> | --self\nArchives using the normal user action, retains history, and does not ask for confirmation.\n--self uses HAPI_SESSION_ID. Self-archive can close this terminal before the response arrives.\nUse Reopen in HAPI to continue an archived chat.')
                return
            }
            if (!args.self && args.sessionIdPrefix === undefined) {
                throw new PingPeerError('bad_args', 'Provide a session id or --self; use hapi archive-peer --help')
            }
            if (args.self && !process.env.HAPI_SESSION_ID?.trim()) {
                throw new PingPeerError('bad_args', '--self requires HAPI_SESSION_ID from a HAPI chat')
            }
            await initializeToken()
            const result = await archivePeer({
                sessionIdPrefix: args.sessionIdPrefix,
                currentSessionId: args.self ? process.env.HAPI_SESSION_ID : undefined
            })
            console.log(`${result.alreadyArchived ? 'Already archived' : 'Archived'} ${result.sessionId} (${result.name}). History retained.`)
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error))
            process.exit(error instanceof PingPeerError ? exitCodeForPingPeerError(error) : 1)
        }
    }
}
