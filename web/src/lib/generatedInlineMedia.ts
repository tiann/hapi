export function isInlineVideoMimeType(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('video/')
}

export function isInlineAudioMimeType(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('audio/')
}

export function isInlineImageMimeType(mimeType: string | null | undefined): boolean {
    return mimeType == null || mimeType.startsWith('image/')
}

export function generatedInlineMediaLabel(mimeType: string | null | undefined): 'Generated video' | 'Generated audio' | 'Generated image' | 'Generated file' {
    if (isInlineVideoMimeType(mimeType)) return 'Generated video'
    if (isInlineAudioMimeType(mimeType)) return 'Generated audio'
    if (isInlineImageMimeType(mimeType)) return 'Generated image'
    return 'Generated file'
}
