import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearGeneratedImages, detectImageMimeType, detectVideoMimeType, getGeneratedImage, registerGeneratedImage, registerGeneratedImageFromAcpBlock, registerGeneratedImageFromPath } from './generatedImages'

describe('generatedImages', () => {
    it('detects supported image MIME types from file bytes', () => {
        expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
        expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg')
        expect(detectImageMimeType(Buffer.from('GIF89a'))).toBe('image/gif')
        expect(detectImageMimeType(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
        expect(detectImageMimeType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('image/avif')
    })

    it('detects supported video MIME types from file bytes', () => {
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('video/mp4')
        expect(detectVideoMimeType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm')
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBeNull()
    })

    it('rejects non-image bytes even if the path has an image extension', () => {
        expect(detectImageMimeType(Buffer.from('not really a png'))).toBeNull()
    })

    it('stores only validated MIME type supplied by the server', () => {
        const image = registerGeneratedImage({
            id: 'test-image',
            path: '/tmp/example.png',
            mimeType: 'image/png',
            bytes: Buffer.from('original image bytes')
        })

        expect(image.mimeType).toBe('image/png')
        clearGeneratedImages()
    })

    it('snapshots image bytes at registration time', () => {
        const source = Buffer.from('original image bytes')
        const image = registerGeneratedImage({
            id: 'snapshot-image',
            path: '/tmp/example.png',
            mimeType: 'image/png',
            bytes: source
        })
        source.fill(0)

        expect(image.content.toString()).toBe('original image bytes')
        expect(getGeneratedImage('snapshot-image')?.content.toString()).toBe('original image bytes')
        clearGeneratedImages()
    })

    it('rejects oversized image snapshots', () => {
        expect(() => registerGeneratedImage({
            id: 'too-large-image',
            path: '/tmp/large.png',
            mimeType: 'image/png',
            bytes: new Uint8Array(25 * 1024 * 1024 + 1)
        })).toThrow('File is too large to display inline')
        clearGeneratedImages()
    })

    it('evicts oldest image snapshots when the count limit is exceeded', () => {
        for (let i = 0; i < 101; i += 1) {
            registerGeneratedImage({
                id: `image-${i}`,
                path: `/tmp/image-${i}.png`,
                mimeType: 'image/png',
                bytes: Buffer.from(`image-${i}`)
            })
        }

        expect(getGeneratedImage('image-0')).toBeNull()
        expect(getGeneratedImage('image-1')).not.toBeNull()
        expect(getGeneratedImage('image-100')).not.toBeNull()
        clearGeneratedImages()
    })

    it('registers images from ACP base64 image blocks after MIME sniffing', async () => {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
        const image = await registerGeneratedImageFromAcpBlock({
            type: 'image',
            mimeType: 'image/png',
            data: pngHeader.toString('base64')
        })

        expect(image?.mimeType).toBe('image/png')
        expect(getGeneratedImage(image!.id)?.content.subarray(0, 8)).toEqual(pngHeader.subarray(0, 8))
        clearGeneratedImages()
    })

    it('ignores URI-only ACP image blocks that would read local disk without a permission prompt', async () => {
        const dir = join(tmpdir(), `hapi-acp-uri-only-${Date.now()}`)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'secret.png')
        writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))

        await expect(registerGeneratedImageFromAcpBlock({
            type: 'image',
            uri: `file://${path}`
        })).resolves.toBeNull()

        await expect(registerGeneratedImageFromAcpBlock({
            type: 'image',
            url: path
        })).resolves.toBeNull()
    })

    it('registers images from local file paths in ACP uri blocks', async () => {
        const dir = join(tmpdir(), `hapi-acp-image-${Date.now()}`)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'inline.png')
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
        writeFileSync(path, bytes)

        const image = await registerGeneratedImageFromPath({ path })
        expect(image?.mimeType).toBe('image/png')
        clearGeneratedImages()
    })

    it('registers mp4 from local file paths after MIME sniffing', async () => {
        const dir = join(tmpdir(), `hapi-inline-mp4-${Date.now()}`)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'inline.mp4')
        const bytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        writeFileSync(path, bytes)

        const video = await registerGeneratedImageFromPath({ path })
        expect(video?.mimeType).toBe('video/mp4')
        clearGeneratedImages()
    })

})
