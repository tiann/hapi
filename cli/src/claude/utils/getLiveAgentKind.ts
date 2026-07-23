import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'

/**
 * Live agent kind reported by the local Claude daemon roster.
 *
 * A Claude session can be in one of three states from HAPI's point of view:
 *   - dead (only a `<id>.jsonl` transcript on disk) -> can be resumed directly
 *   - alive as a background agent -> `--resume` is rejected; must `--fork-session`
 *   - alive as an interactive agent -> same, must `--fork-session`
 *
 * `claudeCheckSession` only answers "does a resumable transcript exist"; it
 * cannot tell whether the session is currently held open by a running agent.
 */
export type LiveAgentKind = 'background' | 'interactive'

const AGENTS_QUERY_TIMEOUT_MS = 5_000

interface ClaudeAgentEntry {
    sessionId?: unknown
    kind?: unknown
}

/**
 * Determine whether `sessionId` is currently held open by a running Claude
 * agent (background or interactive), per the local daemon roster
 * (`claude agents --json`).
 *
 * Returns the agent `kind` when the session is alive, or `null` when it is not
 * in the roster, the command is unavailable / times out, or the output cannot
 * be parsed. Returning `null` is the safe degradation: the caller treats the
 * session as dead and resumes it directly (current behavior), so this never
 * blocks the resume path.
 */
export function getLiveAgentKind(sessionId: string): LiveAgentKind | null {
    if (!sessionId) {
        return null
    }

    let raw: string
    try {
        raw = execFileSync(getDefaultClaudeCodePath(), ['agents', '--json'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
            timeout: AGENTS_QUERY_TIMEOUT_MS,
            env: withBunRuntimeEnv(process.env, { allowBunBeBun: false }),
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        })
    } catch (e) {
        // Command missing, daemon down, timeout, non-zero exit, etc.
        // Degrade to "treat as dead" so the resume path is never blocked.
        logger.debug('[getLiveAgentKind] failed to query claude agents', e)
        return null
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        logger.debug('[getLiveAgentKind] failed to parse claude agents --json output', e)
        return null
    }

    if (!Array.isArray(parsed)) {
        return null
    }

    for (const entry of parsed as ClaudeAgentEntry[]) {
        if (!entry || typeof entry !== 'object') {
            continue
        }
        if (entry.sessionId !== sessionId) {
            continue
        }
        if (entry.kind === 'background' || entry.kind === 'interactive') {
            return entry.kind
        }
        // Session is in the roster but with an unknown/foreign kind: it is still
        // held open, so fork rather than risk an occupied-session resume.
        return 'background'
    }

    return null
}
