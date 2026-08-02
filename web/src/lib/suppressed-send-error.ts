/**
 * Moves a retry-suppressed inline send error to the session selected by an
 * inactive-session resume. The record stays visible while the retry runs, but
 * must follow the eventual mutation target so success/error can resolve it.
 */
export function migrateSuppressedSendError<T extends { restoreSuppressed: boolean }>(
    errors: Readonly<Record<string, T>>,
    sourceSessionId: string,
    resolvedSessionId: string,
): Record<string, T> {
    if (sourceSessionId === resolvedSessionId) return errors as Record<string, T>
    const source = errors[sourceSessionId]
    if (!source?.restoreSuppressed) return errors as Record<string, T>

    const next = { ...errors }
    delete next[sourceSessionId]
    // The retry being resumed is the authoritative in-flight operation, so it
    // intentionally supersedes any stale target-session error record.
    next[resolvedSessionId] = source
    return next
}
