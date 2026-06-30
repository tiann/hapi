import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearGeneratedImages, detectImageMimeType, getGeneratedImage, registerGeneratedImage } from './generatedImages'

describe('generatedImages', () => {
    afterEach(() => {
        clearGeneratedImages()
    })

    it('detects supported image MIME types from file bytes', () => {
        expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
        expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg')
        expect(detectImageMimeType(Buffer.from('GIF89a'))).toBe('image/gif')
        expect(detectImageMimeType(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
        expect(detectImageMimeType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('image/avif')
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
        })).toThrow('Image is too large to display inline')
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
    })

    it('loads persisted images back after cache clear', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-generated-images-'))
        const prev = process.env.CODEX_HOME
        process.env.CODEX_HOME = dir
        try {
            registerGeneratedImage({
                id: 'persisted-image',
                path: '/tmp/example.png',
                mimeType: 'image/png',
                bytes: Buffer.from('persisted')
            })
            clearGeneratedImages()
            expect(getGeneratedImage('persisted-image')?.content.toString()).toBe('persisted')
        } finally {
            if (prev === undefined) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = prev
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('evicts old persisted images across memory cache clears', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-generated-images-'))
        const prev = process.env.CODEX_HOME
        process.env.CODEX_HOME = dir
        try {
            for (let i = 0; i < 101; i += 1) {
                registerGeneratedImage({
                    id: `persisted-${i}`,
                    path: `/tmp/persisted-${i}.png`,
                    mimeType: 'image/png',
                    bytes: Buffer.from(`persisted-${i}`)
                })
                clearGeneratedImages()
            }

            expect(existsSync(join(dir, 'generated-images', 'persisted-0.bin'))).toBe(false)
            expect(existsSync(join(dir, 'generated-images', 'persisted-100.bin'))).toBe(true)
        } finally {
            if (prev === undefined) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = prev
            rmSync(dir, { recursive: true, force: true })
        }
    })

})
