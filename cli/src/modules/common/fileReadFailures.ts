import type { FileReadFailureReason } from '@hapi/protocol/apiTypes'
import { BoundedFileReadError } from './generatedImages'

export class FileReadFailureError extends Error {
    constructor(
        readonly reason: FileReadFailureReason,
        message: string,
        readonly size?: number,
    ) {
        super(message)
        this.name = 'FileReadFailureError'
    }
}

export type ClassifiedFileReadFailure = {
    reason: FileReadFailureReason
    size?: number
}

export function classifyFileReadError(error: unknown): ClassifiedFileReadFailure {
    if (error instanceof FileReadFailureError || error instanceof BoundedFileReadError) {
        return {
            reason: error.reason,
            ...(error.size === undefined ? {} : { size: error.size }),
        }
    }

    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null
    if (code === 'ENOENT' || code === 'ENOTDIR') return { reason: 'not-found' }
    if (code === 'EACCES' || code === 'EPERM') return { reason: 'access-denied' }
    if (code === 'EISDIR') return { reason: 'not-regular-file' }
    return { reason: 'read-failed' }
}