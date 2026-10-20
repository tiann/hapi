import { logger } from '@/ui/logger'
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import type { PermissionMode } from './types'
import { assertSafeWindowsShellArg } from './utils/windowsShellArgs'
import { isPeerToolsDisabled, withPeerToolsPreference } from '@/modules/common/peerTools'

type GrokLocalOptions = {
    sessionId: string
    resume: boolean
    model?: string
    effort?: string
    permissionMode?: PermissionMode
    /** Session peer-tools snapshot; resolved preference pins the child env. */
    peerToolsDisabled?: boolean
}

export function buildGrokLocalArgs(opts: GrokLocalOptions): string[] {
    assertSafeWindowsShellArg(opts.sessionId, 'sessionId')
    if (opts.model) assertSafeWindowsShellArg(opts.model, 'model')
    if (opts.effort) assertSafeWindowsShellArg(opts.effort, 'effort')

    const args: string[] = []

    if (opts.resume) {
        args.push('--resume', opts.sessionId)
    } else {
        args.push('--session-id', opts.sessionId)
    }
    if (opts.model) {
        args.push('--model', opts.model)
    }
    if (opts.effort) {
        args.push('--reasoning-effort', opts.effort)
    }
    if (opts.permissionMode && opts.permissionMode !== 'default') {
        args.push('--permission-mode', opts.permissionMode)
    }
    return args
}

export async function grokLocal(opts: GrokLocalOptions & {
    path: string
    abort: AbortSignal
}): Promise<void> {
    const args = buildGrokLocalArgs(opts)

    logger.debug(`[GrokLocal] Spawning grok with args: ${JSON.stringify(args)}`)

    await spawnWithTerminalGuard({
        command: getAgentLaunchCommand('grok'),
        args,
        cwd: opts.path,
        // Pin the session's peer-tools preference so a Grok agent shelling
        // `hapi ping-peer` resolves it in the fresh child process (#2056).
        env: withPeerToolsPreference(opts.peerToolsDisabled ?? isPeerToolsDisabled()),
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'GrokLocal',
        spawnName: 'grok',
        installHint: 'Grok Build CLI (https://docs.x.ai/build/overview)',
        includeCause: true,
        logExit: true
    })
}
