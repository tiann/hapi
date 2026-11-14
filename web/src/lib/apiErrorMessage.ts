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
