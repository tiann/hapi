import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { asString, isObject } from '@hapi/protocol'

/**
 * Read a regular file through one open descriptor: size is taken from the fd
 * (not a separate pathname `lstat`), then the buffer is allocated to that size
 * only. Rejects if the file grows/shrinks while reading so a TOCTOU swap cannot
 * force an unbounded `readFile` allocation.
 */
export async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, 'r')
    try {
        const info = await handle.stat()
        if (!info.isFile()) {
            throw new Error('Path is not a regular file')
        }
        if (info.size > maxBytes) {
            throw new Error('File is too large to display inline')
        }
        const bytes = Buffer.alloc(info.size)
        for (let offset = 0; offset < bytes.length;) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) {
                throw new Error('File changed while reading')
            }
            offset += bytesRead
        }
        if ((await handle.stat()).size !== info.size) {
            throw new Error('File changed while reading')
        }
        return bytes
    } finally {
        await handle.close()
    }
}

export type GeneratedImageMetadata = {
    id: string
    fileName: string
    content: Buffer
    mimeType: string
    createdAt: number
}

export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024
/** Reject base64 strings that cannot fit under MAX_GENERATED_IMAGE_BYTES once decoded (+ padding). */
export const MAX_GENERATED_IMAGE_BASE64_CHARS = Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4
const MAX_GENERATED_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_GENERATED_IMAGE_COUNT = 100

/** Decode inline media base64 only after a cheap length gate (avoids huge Buffer allocations). */
export function decodeGeneratedImageBase64(data: string): Buffer | null {
    if (data.length > MAX_GENERATED_IMAGE_BASE64_CHARS) {
        return null
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
        return null
    }
    return bytes
}

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

const MP4_FTYP_BRANDS = new Set([
    'isom',
    'iso2',
    'iso3',
    'iso4',
    'iso5',
    'iso6',
    'mp41',
    'mp42',
    'mp71',
    'avc1',
    'avc3',
    'hev1',
    'hvc1',
    'mmp4',
    'dash',
    'msnv',
    'ndas',
    'ndsc',
    'ndsh',
    'ndsm',
    'ndsp',
    'ndss',
    'ndxc',
    'ndxh',
    'ndxm',
    'ndxp',
    'ndxs',
])

/** EBML DocType (element 0x4282) from the first header bytes; null if absent/unreadable. */
function readEbmlDocType(bytes: Uint8Array): string | null {
    const limit = Math.min(bytes.length, 128)
    for (let i = 4; i + 3 < limit; i += 1) {
        if (bytes[i] !== 0x42 || bytes[i + 1] !== 0x82) {
            continue
        }
        const sizeByte = bytes[i + 2]
        // Single-byte VINT: high bit set, length in low 7 bits.
        if ((sizeByte & 0x80) === 0) {
            continue
        }
        const len = sizeByte & 0x7f
        if (len === 0 || i + 3 + len > limit) {
            continue
        }
        return ascii(bytes, i + 3, i + 3 + len)
    }
    return null
}

export function detectVideoMimeType(bytes: Uint8Array): string | null {
    if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
        const brand = ascii(bytes, 8, 12)
        if (MP4_FTYP_BRANDS.has(brand)) {
            return 'video/mp4'
        }
        return null
    }

    if (bytes.length >= 4
        && bytes[0] === 0x1a
        && bytes[1] === 0x45
        && bytes[2] === 0xdf
        && bytes[3] === 0xa3) {
        // EBML is shared by WebM and Matroska/MKV — only accept DocType webm.
        if (readEbmlDocType(bytes) === 'webm') {
            return 'video/webm'
        }
        return null
    }

    return null
}

export function detectAudioMimeType(bytes: Uint8Array): string | null {
    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
        return 'audio/wav'
    }

    if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'fLaC') {
        return 'audio/flac'
    }

    if (bytes.length >= 32 && ascii(bytes, 0, 4) === 'OggS') {
        const probe = ascii(bytes, 0, Math.min(bytes.length, 96))
        if (probe.includes('OpusHead') || probe.includes('vorbis') || probe.includes('Speex')) {
            return 'audio/ogg'
        }
    }

    if (bytes.length >= 3 && ascii(bytes, 0, 3) === 'ID3') {
        return 'audio/mpeg'
    }

    if (bytes.length >= 3
        && bytes[0] === 0xff
        && (bytes[1] & 0xe0) === 0xe0
        && (bytes[1] & 0x18) !== 0x08
        && (bytes[1] & 0x06) !== 0
        && (bytes[2] & 0xf0) !== 0
        && (bytes[2] & 0xf0) !== 0xf0
        && (bytes[2] & 0x0c) !== 0x0c) {
        return 'audio/mpeg'
    }

    if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
        const brand = ascii(bytes, 8, 12)
        if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
            return 'audio/mp4'
        }
    }

    return null
}

function detectIsoBmffTrackKind(bytes: Uint8Array): 'audio' | 'video' | null {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let hasAudio = false
    let hasVideo = false

    function visitBoxes(start: number, end: number, parent: 'root' | 'moov' | 'trak' | 'mdia'): boolean {
        let offset = start
        for (; offset + 8 <= end;) {
            const size32 = buffer.readUInt32BE(offset)
            const type = ascii(bytes, offset + 4, offset + 8)
            let headerSize = 8
            let boxSize: number
            if (size32 === 0) {
                boxSize = end - offset
            } else if (size32 === 1) {
                if (offset + 16 > end) return false
                const extendedSize = buffer.readBigUInt64BE(offset + 8)
                if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false
                headerSize = 16
                boxSize = Number(extendedSize)
            } else {
                boxSize = size32
            }
            if (boxSize < headerSize || boxSize > end - offset) return false

            const payloadStart = offset + headerSize
            const boxEnd = offset + boxSize
            if (parent === 'root' && type === 'moov') {
                if (!visitBoxes(payloadStart, boxEnd, 'moov')) return false
            } else if (parent === 'moov' && type === 'trak') {
                if (!visitBoxes(payloadStart, boxEnd, 'trak')) return false
            } else if (parent === 'trak' && type === 'mdia') {
                if (!visitBoxes(payloadStart, boxEnd, 'mdia')) return false
            } else if (parent === 'mdia' && type === 'hdlr') {
                if (boxSize < headerSize + 12) return false
                const handlerType = ascii(bytes, payloadStart + 8, payloadStart + 12)
                if (handlerType === 'soun') hasAudio = true
                if (handlerType === 'vide') hasVideo = true
            }

            offset = boxEnd
        }
        return offset === end
    }

    if (!visitBoxes(0, bytes.length, 'root')) return null
    if (hasVideo) return 'video'
    if (hasAudio) return 'audio'
    return null
}

export function isInlineMediaMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
}

export function detectDisplayMediaMimeType(bytes: Uint8Array): string {
    const imageMimeType = detectImageMimeType(bytes)
    if (imageMimeType) return imageMimeType

    if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
        const trackKind = detectIsoBmffTrackKind(bytes)
        if (trackKind === 'video') return 'video/mp4'
        if (trackKind === 'audio') return 'audio/mp4'
        return detectAudioMimeType(bytes) ?? 'application/octet-stream'
    }

    return detectVideoMimeType(bytes)
        ?? detectAudioMimeType(bytes)
        ?? 'application/octet-stream'
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.subarray(start, end))
}

export function registerGeneratedImage(args: { id: string; path: string; mimeType: string; bytes: Uint8Array; fileName?: string | null }): GeneratedImageMetadata {
    const content = Buffer.from(args.bytes)
    if (content.byteLength > MAX_GENERATED_IMAGE_BYTES) {
        throw new Error('File is too large to display inline')
    }

    if (!isInlineMediaMimeType(args.mimeType) && args.mimeType !== 'application/octet-stream') {
        throw new Error('Unsupported generated media MIME type')
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
        const bytes = await readBoundedRegularFile(args.path, MAX_GENERATED_IMAGE_BYTES)
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

/** Bound safe display name from an ACP uri/url — never reuse raw data/signed URLs. */
export function safeAcpFileName(uri: string | undefined | null): string | null {
    if (!uri) return null
    try {
        if (uri.startsWith('file://')) {
            return basename(fileURLToPath(uri)).slice(0, 255) || null
        }
        if (/^https?:\/\//i.test(uri)) {
            const name = basename(new URL(uri).pathname)
            return name.slice(0, 255) || null
        }
        // Reject scheme-bearing forms (data:, blob:, etc.) — only bare paths.
        if (!uri.includes(':')) {
            return basename(uri).slice(0, 255) || null
        }
    } catch {
        return null
    }
    return null
}

export async function registerGeneratedImageFromAcpBlock(block: unknown): Promise<GeneratedImageMetadata | null> {
    if (!isObject(block) || block.type !== 'image') {
        return null
    }

    const data = asString(block.data)
    const declaredMimeType = asString(block.mimeType ?? block.mime_type)
    const uri = asString(block.uri ?? block.url)

    if (data) {
        const bytes = decodeGeneratedImageBase64(data)
        if (!bytes) {
            return null
        }
        const sniffedMimeType = detectImageMimeType(bytes)
        if (!sniffedMimeType) {
            return null
        }
        if (declaredMimeType && declaredMimeType !== sniffedMimeType) {
            return null
        }
        const localPath = uri ? parseAcpImageUri(uri) : null
        const fileName = safeAcpFileName(uri) ?? `generated-${randomUUID()}.png`
        return registerGeneratedImage({
            id: randomUUID(),
            path: localPath ?? fileName,
            fileName,
            mimeType: sniffedMimeType,
            bytes
        })
    }

    // URI-only ACP image blocks are not permission-gated. Local-path display must
    // go through display_image / display_video / display_media MCP tools (approval_mode: prompt).
    return null
}
