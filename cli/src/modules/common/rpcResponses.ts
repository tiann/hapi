export type RpcErrorResponse = { success: false; error: string }

export type RpcSuccessResponse<T extends object> = { success: true } & T

export function rpcError<T extends Record<string, unknown> = Record<string, unknown>>(
    message: string,
    extras?: T
): RpcErrorResponse & T {
    const payload = {
        success: false,
        error: message,
        ...(extras ?? {})
    }

    return payload as RpcErrorResponse & T
}

export function getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
        return error.message
    }
    return fallback
}
