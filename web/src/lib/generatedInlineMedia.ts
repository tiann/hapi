export function isInlineVideoMimeType(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && mimeType.startsWith('video/')
}

export function generatedInlineMediaLabel(mimeType: string | null | undefined): 'Generated video' | 'Generated image' {
    return isInlineVideoMimeType(mimeType) ? 'Generated video' : 'Generated image'
}
