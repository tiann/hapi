import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError } from '@/api/client'

export function isRpcTargetMissingCode(code: string | undefined): boolean {
    return code === RPC_TARGET_MISSING_ERROR_CODE
}

export function isRpcTargetMissingError(error: unknown): boolean {
    return error instanceof ApiError && isRpcTargetMissingCode(error.code)
}

export function hasRpcTargetMissingResponse(
    response: { success: boolean; code?: string } | undefined
): boolean {
    return response?.success === false && isRpcTargetMissingCode(response.code)
}

export async function catchRpcTargetMissing<T extends { success: boolean; code?: string; error?: string }>(
    fn: () => Promise<T>
): Promise<T> {
    try {
        return await fn()
    } catch (error: unknown) {
        const apiError = error instanceof ApiError ? error : null
        if (apiError && isRpcTargetMissingCode(apiError.code)) {
            return {
                success: false,
                error: apiError.message,
                code: RPC_TARGET_MISSING_ERROR_CODE
            } as unknown as T
        }
        throw error
    }
}
