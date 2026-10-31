export class InvalidExternalRefsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'InvalidExternalRefsError'
    }
}

// Thrown by mergeSessionMetadataForSessionMerge instead of silently dropping
// the losing side's refs (Codex review, hapi#238/#2147): for a merge that
// deletes the source session (mergeSessions), dropping its unique links to
// stay under the cap is an unrecoverable, unannounced loss the moment the
// row is gone. The caller decides what this means for its own merge variant
// — see mergeSessionMetadataForTransfer.
export class ExternalRefsMergeCapExceededError extends Error {
    constructor() {
        super('External refs union would exceed the cap')
        this.name = 'ExternalRefsMergeCapExceededError'
    }
}

export type ExternalRefRouteStatus = 400 | 409 | 500

export function mapExternalRefRouteError(
    error: unknown,
    fallbackMessage: string
): { message: string; status: ExternalRefRouteStatus } {
    if (error instanceof InvalidExternalRefsError) {
        return { message: error.message, status: 400 }
    }
    const message = error instanceof Error ? error.message : fallbackMessage
    if (message.includes('concurrently') || message.includes('version')) {
        return { message, status: 409 }
    }
    return { message, status: 500 }
}
