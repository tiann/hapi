export class InvalidExternalRefsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'InvalidExternalRefsError'
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
