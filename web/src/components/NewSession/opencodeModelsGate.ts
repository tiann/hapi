import type { AgentType } from './types'

/**
 * Decide whether the new-session form should fire OpenCode model discovery
 * for the current input state.
 *
 * Discovery is gated on the cwd having been *positively* confirmed to exist
 * on the target machine. While `cwdExists` is undefined (existence probe in
 * flight) or false (typing through a partial path), we suppress discovery so
 * the CLI does not spawn an `opencode acp` subprocess for a non-existent
 * directory only to time out 30 seconds later.
 */
export function shouldEnableOpencodeModelDiscovery(args: {
    agent: AgentType
    machineId: string | null
    cwd: string
    cwdExists: boolean | undefined
}): boolean {
    if (args.agent !== 'opencode') return false
    if (!args.machineId) return false
    if (args.cwd.length === 0) return false
    return args.cwdExists === true
}
