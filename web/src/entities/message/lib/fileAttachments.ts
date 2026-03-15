import type { UploadFileResponse } from '@/types/api'

export type FileAttachment = {
    id: string
    file: File
    status: 'uploading' | 'complete' | 'error'
    path?: string
    error?: string
}

export type UploadFunction = (file: File) => Promise<UploadFileResponse>

export function createFileAttachment(file: File): FileAttachment {
    return {
        id: crypto.randomUUID(),
        file,
        status: 'uploading'
    }
}

export function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/')
}
