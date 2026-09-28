/**
 * Decide whether a Claude `sessionFound` id should update durable metadata.
 *
 * When HAPI asked Claude to `--resume A` and Claude reports B≠A without an
 * explicit fork, overwriting `metadata.claudeSessionId` burns the last good
 * resume pointer (tiann/hapi#1933). Keep A and treat the mismatch as failure.
 */

export type ClaudeSessionFoundDecision =
    | { action: 'accept'; sessionId: string; extras?: { forkedFrom: string } }
    | {
        action: 'reject'
        requestedId: string
        reportedId: string
        reason: 'resume_mismatch'
    }

/** Pull a UUID-like `--resume <id>` value from Claude CLI args, if present. */
export function extractResumeIdFromClaudeArgs(claudeArgs: string[] | undefined): string | null {
    if (!claudeArgs) return null
    for (let i = 0; i < claudeArgs.length; i++) {
        if (claudeArgs[i] !== '--resume') continue
        if (i + 1 >= claudeArgs.length) return null
        const nextArg = claudeArgs[i + 1]
        if (!nextArg.startsWith('-') && nextArg.includes('-')) {
            return nextArg
        }
        return null
    }
    return null
}

/** Resume target claudeRemote passes to the SDK (sessionId wins over args). */
export function resolveClaudeRemoteResumeTarget(
    sessionId: string | null | undefined,
    claudeArgs?: string[]
): string | null {
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        return sessionId.trim()
    }
    return extractResumeIdFromClaudeArgs(claudeArgs)
}

/**
 * Guard id for a local launch: explicit `--resume <id>` wins; `--continue`
 * or bare `--resume` (picker / no UUID) clears the guard; otherwise use the
 * stored session id.
 */
export function resolveClaudeLocalResumeGuardId(
    sessionId: string | null | undefined,
    claudeArgs?: string[]
): string | null {
    if (claudeArgs?.includes('--continue')) {
        return null
    }
    if (claudeArgs?.includes('--resume')) {
        const fromArgs = extractResumeIdFromClaudeArgs(claudeArgs)
        // Bare `--resume` (no UUID) is user session control — do not guard
        // against a stored id the user is deliberately leaving.
        return fromArgs
    }
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) {
        return sessionId.trim()
    }
    return null
}

/**
 * Initial mismatch-guard id. Matches the remote SDK resume target (sessionId
 * preferred). Launchers rearm before each spawn for local vs remote rules.
 */
export function resolveClaudeResumeGuardId(
    sessionId: string | null | undefined,
    claudeArgs?: string[]
): string | null {
    return resolveClaudeRemoteResumeTarget(sessionId, claudeArgs)
}

export function decideClaudeSessionFound(opts: {
    requestedId: string | null | undefined
    reportedId: string
    forkRequested?: boolean
}): ClaudeSessionFoundDecision {
    const requested = typeof opts.requestedId === 'string' && opts.requestedId.trim().length > 0
        ? opts.requestedId.trim()
        : null
    const reported = opts.reportedId.trim()
    if (!reported) {
        if (requested) {
            return {
                action: 'reject',
                requestedId: requested,
                reportedId: reported,
                reason: 'resume_mismatch'
            }
        }
        return { action: 'accept', sessionId: reported }
    }

    if (!requested || requested === reported) {
        return { action: 'accept', sessionId: reported }
    }

    if (opts.forkRequested) {
        return {
            action: 'accept',
            sessionId: reported,
            extras: { forkedFrom: requested }
        }
    }

    return {
        action: 'reject',
        requestedId: requested,
        reportedId: reported,
        reason: 'resume_mismatch'
    }
}
