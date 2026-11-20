import { ApiError } from '@/api/client'

/**
 * Extracts the hub's crafted `{ error: string }` message from an ApiError's
 * body, falling back to the raw Error message (or a caller-supplied default)
 * when the body isn't that shape. Without this, ApiError.message surfaces the
 * raw "HTTP 400 Bad Request: {...}" string instead of the server's message.
 */
export function getApiErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.body) {
        try {
            const parsed = JSON.parse(err.body) as { error?: unknown }
            if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
        } catch {
            // fall through
        }
    }
    return err instanceof Error ? err.message : fallback
}

/**
 * Extracts an optional `url` the hub attached to an error body — used for
 * partial-failure writes (e.g. an issue gets created but adding it to the
 * project then fails) where the orphaned resource's own URL is the most
 * useful thing to hand the user, not just prose that happens to mention it.
 */
export function getApiErrorUrl(err: unknown): string | null {
    if (err instanceof ApiError && err.body) {
        try {
            const parsed = JSON.parse(err.body) as { url?: unknown }
            if (typeof parsed.url === 'string' && parsed.url.trim()) return parsed.url
        } catch {
            // fall through
        }
    }
    return null
}

/**
 * Extracts an optional hub-signed `recoveryToken` from an error body — the
 * create-card partial-failure response (issue created, then assignees
 * and/or project-attach failed) carries one so a retry can be trusted
 * without the client re-submitting the issue's url/assignees as free-form
 * fields the hub would otherwise have to take on faith (review finding,
 * tiann/hapi#2147, follow-up).
 */
export function getApiErrorRecoveryToken(err: unknown): string | null {
    if (err instanceof ApiError && err.body) {
        try {
            const parsed = JSON.parse(err.body) as { recoveryToken?: unknown }
            if (typeof parsed.recoveryToken === 'string' && parsed.recoveryToken.trim()) return parsed.recoveryToken
        } catch {
            // fall through
        }
    }
    return null
}

/**
 * Extracts an optional machine-readable `code` the hub attached to an error
 * body — distinct from the human-readable `error` message, which can vary
 * in wording across the several conditions that share one code (review
 * finding, tiann/hapi#2147: the create-card 409 needs a reliable way to
 * tell "the selected template went stale, refetch and let the user pick
 * again" apart from any other failure, which string-matching message text
 * could never do safely).
 */
export function getApiErrorCode(err: unknown): string | null {
    if (err instanceof ApiError && err.body) {
        try {
            const parsed = JSON.parse(err.body) as { code?: unknown }
            if (typeof parsed.code === 'string' && parsed.code.trim()) return parsed.code
        } catch {
            // fall through
        }
    }
    return null
}
