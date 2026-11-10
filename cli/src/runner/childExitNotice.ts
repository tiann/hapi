export type ChildExitNotice = {
    sid: string
    pid: number
    processStartMarker?: string
}

type ExitTrackedSession = {
    requestedHappySessionId?: string
    happySessionId?: string
    sharedSessions?: Record<string, { hostStartMarker?: string } | undefined>
    happySessionMetadataFromLocalWebhook?: { hostStartMarker?: string } | null
}

/**
 * One runner child can own several HAPI rows (shared Codex wrapper), and a
 * spawn can be referred to by its reserved/requested id before the webhook
 * confirms the final row. Collapse all of those aliases into one notice per
 * row, carrying the OS generation so a late/duplicate delivery cannot match a
 * later child that reused the pid.
 */
export function buildChildExitNotices(
    input: {
        pid: number
        processStartMarker?: string | null
        tracked?: ExitTrackedSession | null
        requestedSessionId?: string
        confirmedSessionId?: string
        existingSessionId?: string
    },
    options: {
        intentional: boolean
        // Observation time is carried by the socket payload; accepted here so
        // callers pass one timestamp for the whole exit decision.
        time?: number
    }
): ChildExitNotice[] {
    if (options.intentional) return []

    const processStartMarker = input.processStartMarker
        ?? input.tracked?.happySessionMetadataFromLocalWebhook?.hostStartMarker
        ?? Object.values(input.tracked?.sharedSessions ?? {})
            .map((metadata) => metadata?.hostStartMarker)
            .find((marker): marker is string => typeof marker === 'string' && marker.length > 0)
        ?? undefined

    const ids = new Set<string>()
    const add = (id: string | undefined) => {
        if (typeof id === 'string' && id.length > 0) ids.add(id)
    }
    add(input.requestedSessionId)
    add(input.confirmedSessionId)
    add(input.existingSessionId)
    add(input.tracked?.requestedHappySessionId)
    add(input.tracked?.happySessionId)
    for (const id of Object.keys(input.tracked?.sharedSessions ?? {})) add(id)

    return Array.from(ids, (sid) => ({
        sid,
        pid: input.pid,
        ...(processStartMarker ? { processStartMarker } : {})
    }))
}
