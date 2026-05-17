import { basename, extname } from 'path'

export type GeneratedImageMetadata = {
    id: string
    path: string
    fileName: string
    mimeType: string
    createdAt: number
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.webp': 'image/webp'
}

const generatedImages = new Map<string, GeneratedImageMetadata>()

export function resolveGeneratedImageMimeType(path: string): string {
    return IMAGE_MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function registerGeneratedImage(args: { id: string; path: string; mimeType?: string | null; fileName?: string | null }): GeneratedImageMetadata {
    const metadata: GeneratedImageMetadata = {
        id: args.id,
        path: args.path,
        fileName: args.fileName || basename(args.path) || `${args.id}.png`,
        mimeType: args.mimeType || resolveGeneratedImageMimeType(args.path),
        createdAt: Date.now()
    }
    generatedImages.set(args.id, metadata)
    return metadata
}

export function getGeneratedImage(id: string): GeneratedImageMetadata | null {
    return generatedImages.get(id) ?? null
}

export function clearGeneratedImages(): void {
    generatedImages.clear()
}
