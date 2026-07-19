import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { asString, isObject } from '@hapi/protocol'

export type GeneratedImageMetadata = {
    id: string
    fileName: string
    content: Buffer
    mimeType: string
    createdAt: number
}

export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_GENERATED_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_GENERATED_IMAGE_COUNT = 100

const generatedImages = new Map<string, GeneratedImageMetadata>()
let generatedImageBytes = 0

export function detectImageMimeType(bytes: Uint8Array): string | null {
    if (bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a) {
        return 'image/png'
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg'
    }

    if (bytes.length >= 6) {
        const header = ascii(bytes, 0, 6)
        if (header === 'GIF87a' || header === 'GIF89a') {
            return 'image/gif'
        }
    }

    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
        return 'image/webp'
    }

    if (bytes.length >= 12
        && bytes[0] === 0x00
        && bytes[1] === 0x00
        && bytes[2] === 0x00
        && ascii(bytes, 4, 8) === 'ftyp'
        && (ascii(bytes, 8, 12) === 'avif' || ascii(bytes, 8, 12) === 'avis')) {
        return 'image/avif'
    }

    return null
}

export function detectVideoMimeType(bytes: Uint8Array): string | null {
    if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
        const brand = ascii(bytes, 8, 12)
        if (brand === 'avif' || brand === 'avis') {
            return null
        }
        return 'video/mp4'
    }

    if (bytes.length >= 4
        && bytes[0] === 0x1a
        && bytes[1] === 0x45
        && bytes[2] === 0xdf
        && bytes[3] === 0xa3) {
        return 'video/webm'
    }

    return null
}

export function isInlineMediaMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/') || mimeType.startsWith('video/')
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.subarray(start, end))
}

export function registerGeneratedImage(args: { id: string; path: string; mimeType: string; bytes: Uint8Array; fileName?: string | null }): GeneratedImageMetadata {
    const content = Buffer.from(args.bytes)
    if (content.byteLength > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error('File is too large to display inline')
    }

    if (!isInlineMediaMimeType(args.mimeType)) {
        throw new Error('Unsupported inline media MIME type')
    }

    const previous = generatedImages.get(args.id)
    if (previous) {
        generatedImageBytes -= previous.content.byteLength
    }

    const metadata: GeneratedImageMetadata = {
        id: args.id,
        fileName: args.fileName || basename(args.path) || `${args.id}.png`,
        content,
        mimeType: args.mimeType,
        createdAt: Date.now()
    }
    generatedImages.set(args.id, metadata)
    generatedImageBytes += content.byteLength

    evictOldGeneratedImages()

    return metadata
}

function evictOldGeneratedImages(): void {
    while (generatedImages.size > MAX_GENERATED_IMAGE_COUNT || generatedImageBytes > MAX_GENERATED_IMAGE_TOTAL_BYTES) {
        const oldestId = generatedImages.keys().next().value
        if (!oldestId) break
        const oldest = generatedImages.get(oldestId)
        if (oldest) {
            generatedImageBytes -= oldest.content.byteLength
        }
        generatedImages.delete(oldestId)
    }
}

export function getGeneratedImage(id: string): GeneratedImageMetadata | null {
    return generatedImages.get(id) ?? null
}

export function clearGeneratedImages(): void {
    generatedImages.clear()
    generatedImageBytes = 0
}

export async function registerGeneratedImageFromPath(args: {
    id?: string
    path: string
    fileName?: string | null
}): Promise<GeneratedImageMetadata | null> {
    try {
        const info = await lstat(args.path)
        if (!info.isFile()) {
            throw new Error('Path is not a regular file')
        }
        if (info.size > MAX_GENERATED_IMAGE_BYTES) {
            throw new Error('Image is too large to display inline')
        }
        const bytes = await readFile(args.path)
        const mimeType = detectImageMimeType(bytes) ?? detectVideoMimeType(bytes)
        if (!mimeType) {
            throw new Error('Unsupported inline media content')
        }
        return registerGeneratedImage({
            id: args.id ?? randomUUID(),
            path: args.path,
            fileName: args.fileName,
            mimeType,
            bytes
        })
    } catch {
        return null
    }
}

function parseAcpImageUri(uri: string): string | null {
    if (uri.startsWith('file://')) {
        try {
            return fileURLToPath(uri)
        } catch {
            return null
        }
    }
    if (/^https?:\/\//i.test(uri)) {
        return null
    }
    return uri
}

export async function registerGeneratedImageFromAcpBlock(block: unknown): Promise<GeneratedImageMetadata | null> {
    if (!isObject(block) || block.type !== 'image') {
        return null
    }

    const data = asString(block.data)
    const declaredMimeType = asString(block.mimeType ?? block.mime_type)
    const uri = asString(block.uri ?? block.url)

    if (data) {
        const bytes = Buffer.from(data, 'base64')
        if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
            return null
        }
        const sniffedMimeType = detectImageMimeType(bytes)
        if (!sniffedMimeType) {
            return null
        }
        if (declaredMimeType && declaredMimeType !== sniffedMimeType) {
            return null
        }
        const path = uri ? parseAcpImageUri(uri) ?? uri : `${randomUUID()}.bin`
        return registerGeneratedImage({
            id: randomUUID(),
            path,
            fileName: basename(path),
            mimeType: sniffedMimeType,
            bytes
        })
    }

    // URI-only ACP image blocks are not permission-gated. Local-path display must
    // go through display_image / display_video MCP tools (approval_mode: prompt).
    return null
}
