import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { clearGeneratedImages, decodeGeneratedImageBase64, detectAudioMimeType, detectDisplayMediaMimeType, detectImageMimeType, detectVideoMimeType, flushGeneratedImageDiskWritesForTesting, getGeneratedImage, MAX_GENERATED_IMAGE_BASE64_CHARS, MAX_GENERATED_IMAGE_BYTES, readBoundedRegularFile, registerGeneratedImage, registerGeneratedImageFromAcpBlock, registerGeneratedImageFromPath, resetGeneratedImageMemoryCacheForTesting, resolveGeneratedImage, safeAcpFileName } from './generatedImages'

const execFileAsync = promisify(execFile)

describe('generatedImages', () => {
    let prevCacheDirOverride: string | undefined
    let suiteCacheDir: string

    beforeAll(async () => {
        prevCacheDirOverride = process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        suiteCacheDir = await mkdtemp(join(tmpdir(), 'hapi-genimg-suite-'))
        process.env.HAPI_GENERATED_MEDIA_CACHE_DIR = suiteCacheDir
    })

    afterAll(async () => {
        clearGeneratedImages()
        await flushGeneratedImageDiskWritesForTesting()
        if (prevCacheDirOverride === undefined) {
            delete process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        } else {
            process.env.HAPI_GENERATED_MEDIA_CACHE_DIR = prevCacheDirOverride
        }
        await rm(suiteCacheDir, { recursive: true, force: true })
    })
    it('detects supported image MIME types from file bytes', () => {
        expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
        expect(detectImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg')
        expect(detectImageMimeType(Buffer.from('GIF89a'))).toBe('image/gif')
        expect(detectImageMimeType(Buffer.from('RIFFxxxxWEBP'))).toBe('image/webp')
        expect(detectImageMimeType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBe('image/avif')
    })

    it('detects supported video MIME types from file bytes', () => {
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('video/mp4')
        // EBML + DocType "webm" (0x4282 / VINT len 4 / "webm")
        expect(detectVideoMimeType(Buffer.from([
            0x1a, 0x45, 0xdf, 0xa3,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
            0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
        ]))).toBe('video/webm')
        // Bare EBML magic (or Matroska DocType) must not claim video/webm
        expect(detectVideoMimeType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull()
        expect(detectVideoMimeType(Buffer.from([
            0x1a, 0x45, 0xdf, 0xa3,
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f,
            0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61,
        ]))).toBeNull()
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBeNull()
        // HEIC/HEIF uses ftyp but is not a supported inline video container
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeNull()
        expect(detectVideoMimeType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31]))).toBeNull()
    })

    it('detects supported audio MIME types from file bytes', () => {
        expect(detectAudioMimeType(Buffer.from('RIFFxxxxWAVE'))).toBe('audio/wav')
        expect(detectAudioMimeType(Buffer.from('fLaC'))).toBe('audio/flac')
        expect(detectAudioMimeType(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]))).toBe('audio/ogg')
        expect(detectAudioMimeType(Buffer.from('ID3'))).toBe('audio/mpeg')
        expect(detectAudioMimeType(Buffer.from([0xff, 0xfb, 0x90]))).toBe('audio/mpeg')
        expect(detectAudioMimeType(Buffer.from([0xff, 0xe0, 0x00]))).toBeNull()
        expect(detectAudioMimeType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]))).toBe('audio/mp4')
    })

    it('falls back to a download-safe MIME type for unknown files', () => {
        expect(detectDisplayMediaMimeType(Buffer.from('arbitrary file bytes'))).toBe('application/octet-stream')
    })

    it('uses ISO-BMFF track handlers to distinguish audio-only and video files', () => {
        const box = (type: string, payload: Buffer) => {
            const header = Buffer.alloc(8)
            header.writeUInt32BE(header.length + payload.length)
            header.write(type, 4, 4, 'ascii')
            return Buffer.concat([header, payload])
        }
        const ftypIsom = box('ftyp', Buffer.from('isom0000'))
        const track = (handler: 'soun' | 'vide') => box('moov', box('trak', box('mdia', box('hdlr', Buffer.concat([
            Buffer.alloc(8),
            Buffer.from(handler),
            Buffer.alloc(4)
        ])))))

        expect(detectDisplayMediaMimeType(Buffer.concat([ftypIsom, track('soun')]))).toBe('audio/mp4')
        expect(detectDisplayMediaMimeType(Buffer.concat([ftypIsom, track('vide')]))).toBe('video/mp4')
        expect(detectDisplayMediaMimeType(ftypIsom)).toBe('application/octet-stream')
        expect(detectDisplayMediaMimeType(Buffer.concat([
            ftypIsom,
            box('mdat', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('hdlr'), Buffer.alloc(8), Buffer.from('soun')]))
        ]))).toBe('application/octet-stream')
        expect(detectDisplayMediaMimeType(Buffer.concat([ftypIsom, track('soun').subarray(0, -1)]))).toBe('application/octet-stream')
        expect(detectDisplayMediaMimeType(Buffer.concat([ftypIsom, track('soun'), Buffer.alloc(1)]))).toBe('application/octet-stream')
        expect(detectDisplayMediaMimeType(Buffer.concat([
            ftypIsom,
            box('moov', Buffer.concat([box('trak', box('mdia', box('hdlr', Buffer.concat([
                Buffer.alloc(8),
                Buffer.from('soun'),
                Buffer.alloc(4)
            ])))), Buffer.alloc(1)]))
        ]))).toBe('application/octet-stream')
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

    it('stores audio and generic download media', () => {
        const audio = registerGeneratedImage({
            id: 'test-audio',
            path: '/tmp/example.wav',
            mimeType: 'audio/wav',
            bytes: Buffer.from('RIFFxxxxWAVE')
        })
        const file = registerGeneratedImage({
            id: 'test-file',
            path: '/tmp/example.bin',
            mimeType: 'application/octet-stream',
            bytes: Buffer.from('file')
        })

        expect(audio.mimeType).toBe('audio/wav')
        expect(file.mimeType).toBe('application/octet-stream')
        clearGeneratedImages()
    })

    it('preserves the source extension when a custom file name omits one', () => {
        const file = registerGeneratedImage({
            id: 'test-zip-with-title',
            path: '/tmp/plan-a.zip',
            fileName: 'Cursor Plan A Markdown 导出',
            mimeType: 'application/octet-stream',
            bytes: Buffer.from('PK\\x03\\x04')
        })

        expect(file.fileName).toBe('Cursor Plan A Markdown 导出.zip')
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

    it('registers images from ACP base64 image blocks synchronously after MIME sniffing', () => {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
        const image = registerGeneratedImageFromAcpBlock({
            type: 'image',
            mimeType: 'image/png',
            data: pngHeader.toString('base64')
        })

        expect(image?.mimeType).toBe('image/png')
        expect(getGeneratedImage(image!.id)?.content.subarray(0, 8)).toEqual(pngHeader.subarray(0, 8))
        clearGeneratedImages()
    })

    it('rejects oversized base64 before allocating a decoded buffer', async () => {
        const oversized = 'A'.repeat(MAX_GENERATED_IMAGE_BASE64_CHARS + 1)
        expect(decodeGeneratedImageBase64(oversized)).toBeNull()
        expect(registerGeneratedImageFromAcpBlock({
            type: 'image',
            mimeType: 'image/png',
            data: oversized,
        })).toBeNull()
    })

    it('ignores URI-only ACP image blocks that would read local disk without a permission prompt', async () => {
        const dir = join(tmpdir(), `hapi-acp-uri-only-${Date.now()}`)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'secret.png')
        writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))

        expect(registerGeneratedImageFromAcpBlock({
            type: 'image',
            uri: `file://${path}`
        })).toBeNull()

        expect(registerGeneratedImageFromAcpBlock({
            type: 'image',
            url: path
        })).toBeNull()
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

    it('readBoundedRegularFile rejects oversize files without allocating the full path size', async () => {
        const dir = join(tmpdir(), `hapi-bounded-read-${Date.now()}`)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, 'big.bin')
        writeFileSync(path, Buffer.alloc(1024, 0xab))

        await expect(readBoundedRegularFile(path, 512)).rejects.toThrow(/too large/i)
        await expect(readBoundedRegularFile(path, MAX_GENERATED_IMAGE_BYTES)).resolves.toHaveLength(1024)
    })

    it.skipIf(process.platform === 'win32')('rejects a POSIX FIFO without waiting for a writer', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-bounded-fifo-'))
        const fifo = join(dir, 'image.png')
        try {
            await execFileAsync('mkfifo', [fifo])
            const moduleUrl = pathToFileURL(join(process.cwd(), 'src/modules/common/generatedImages.ts')).href
            const script = `
                const { readBoundedRegularFile } = await import(${JSON.stringify(moduleUrl)})
                try {
                    await readBoundedRegularFile(process.env.HAPI_FIFO_PATH, 1024)
                    console.log('unexpected success')
                } catch (error) {
                    console.log(error instanceof Error ? error.message : String(error))
                }
            `
            const bunExec = process.env.HAPI_BUN_EXEC
            if (!bunExec) throw new Error('HAPI_BUN_EXEC is required for the FIFO subprocess test')
            const child = spawn(bunExec, ['--eval', script], {
                cwd: process.cwd(),
                env: { ...process.env, HAPI_FIFO_PATH: fifo },
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            const stdout: Buffer[] = []
            child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
            const result = await Promise.race([
                once(child, 'close').then(([code]) => ({ timedOut: false, code: code as number | null })),
                new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 2000)),
            ])
            if (result.timedOut) {
                child.kill('SIGKILL')
                await once(child, 'close').catch(() => undefined)
                throw new Error('bounded FIFO read timed out')
            }
            expect(result.code).toBe(0)
            expect(Buffer.concat(stdout).toString()).toContain('Path is not a regular file')
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('safeAcpFileName rejects data URIs and strips signed URL query secrets', async () => {
        expect(safeAcpFileName('data:image/png;base64,AAAA')).toBeNull()
        expect(safeAcpFileName('https://cdn.example/img/shot.png?token=secret')).toBe('shot.png')
        expect(safeAcpFileName('file:///tmp/photos/icon.png')).toBe('icon.png')

        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
        const image = registerGeneratedImageFromAcpBlock({
            type: 'image',
            mimeType: 'image/png',
            data: pngHeader.toString('base64'),
            uri: 'data:image/png;base64,' + pngHeader.toString('base64'),
        })
        expect(image?.fileName).toMatch(/^generated-/)
        expect(image?.fileName.startsWith('data:')).toBe(false)
        clearGeneratedImages()
    })

    it('recovers immutable snapshots after memory eviction and restart even if source file changes', async () => {
        clearGeneratedImages()
        const dir = await mkdtemp(join(tmpdir(), 'hapi-genimg-reload-'))
        try {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
            const replacementBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
            const firstPath = join(dir, 'first.png')
            await writeFile(firstPath, pngBytes)
            const first = await registerGeneratedImageFromPath({ id: 'first-id', path: firstPath })
            expect(first).not.toBeNull()

            // Overwrite and remove the original file before eviction; snapshot must remain immutable.
            await writeFile(firstPath, replacementBytes)
            await rm(firstPath)

            for (let i = 0; i < 105; i++) {
                registerGeneratedImage({
                    id: `extra-${i}`,
                    path: `extra-${i}.png`,
                    mimeType: 'image/png',
                    bytes: pngBytes,
                })
            }
            expect(getGeneratedImage('first-id')).toBeNull()

            const reloaded = await resolveGeneratedImage('first-id')
            expect(reloaded?.id).toBe('first-id')
            expect(reloaded?.content.equals(pngBytes)).toBe(true)

            // Simulate process restart (empty in-memory map, intact disk snapshot cache).
            resetGeneratedImageMemoryCacheForTesting()
            expect(getGeneratedImage('first-id')).toBeNull()
            const afterRestart = await resolveGeneratedImage('first-id')
            expect(afterRestart?.id).toBe('first-id')
            expect(afterRestart?.content.equals(pngBytes)).toBe(true)
        } finally {
            clearGeneratedImages()
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('never reads untrusted ACP URI paths after memory eviction', async () => {
        clearGeneratedImages()
        const dir = await mkdtemp(join(tmpdir(), 'hapi-genimg-acp-'))
        try {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
            const secretPath = join(dir, 'secret.png')
            await writeFile(secretPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x99, 0x99, 0x99]))

            const acpImage = registerGeneratedImageFromAcpBlock({
                type: 'image',
                mimeType: 'image/png',
                data: pngBytes.toString('base64'),
                uri: pathToFileURL(secretPath).href,
            })
            expect(acpImage).not.toBeNull()

            resetGeneratedImageMemoryCacheForTesting()
            const resolved = await resolveGeneratedImage(acpImage!.id)
            expect(resolved?.content.equals(pngBytes)).toBe(true)
        } finally {
            clearGeneratedImages()
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('clearGeneratedImages does not wipe sibling worker snapshot files in a shared cache directory', async () => {
        const prevOverride = process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        const prevHome = process.env.HAPI_HOME
        const sharedHome = await mkdtemp(join(tmpdir(), 'hapi-genimg-shared-'))
        delete process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        process.env.HAPI_HOME = sharedHome
        const sharedCacheDir = join(sharedHome, 'cache', 'generated-media')
        mkdirSync(sharedCacheDir, { recursive: true })
        const foreignBin = join(sharedCacheDir, 'foreign-worker.bin')
        writeFileSync(foreignBin, Buffer.from([1, 2, 3, 4]))
        try {
            const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
            const own = registerGeneratedImage({
                id: 'own-worker-img',
                path: 'own.png',
                mimeType: 'image/png',
                bytes: pngBytes,
            })
            expect(own).not.toBeNull()
            await flushGeneratedImageDiskWritesForTesting()
            await resolveGeneratedImage('own-worker-img')

            clearGeneratedImages()
            expect(await readdir(sharedCacheDir)).toContain('foreign-worker.bin')
        } finally {
            clearGeneratedImages()
            await flushGeneratedImageDiskWritesForTesting()
            if (prevHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = prevHome
            if (prevOverride === undefined) delete process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
            else process.env.HAPI_GENERATED_MEDIA_CACHE_DIR = prevOverride
            await rm(sharedHome, { recursive: true, force: true })
        }
    })

    it('bounds pending async disk snapshot writes during synchronous large bursts', async () => {
        const prevOverride = process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        const prevHome = process.env.HAPI_HOME
        const burstHome = await mkdtemp(join(tmpdir(), 'hapi-genimg-burst-'))
        delete process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
        process.env.HAPI_HOME = burstHome
        clearGeneratedImages()
        try {
            const chunk = Buffer.alloc(16 * 1024 * 1024)
            chunk[0] = 0x89
            chunk[1] = 0x50
            chunk[2] = 0x4e
            chunk[3] = 0x47
            chunk[4] = 0x0d
            chunk[5] = 0x0a
            chunk[6] = 0x1a
            chunk[7] = 0x0a

            for (let i = 0; i < 8; i++) {
                registerGeneratedImage({
                    id: `burst-${i}`,
                    path: `burst-${i}.png`,
                    mimeType: 'image/png',
                    bytes: chunk,
                })
            }

            await flushGeneratedImageDiskWritesForTesting()
            const cacheDir = join(burstHome, 'cache', 'generated-media')
            const binFiles = (await readdir(cacheDir)).filter((name) => name.endsWith('.bin'))
            // 8 x 16 MiB = 128 MiB exceeds the 100 MiB pending snapshot budget, so later items must be skipped.
            expect(binFiles.length).toBe(6)
        } finally {
            clearGeneratedImages()
            await flushGeneratedImageDiskWritesForTesting()
            if (prevHome === undefined) delete process.env.HAPI_HOME
            else process.env.HAPI_HOME = prevHome
            if (prevOverride === undefined) delete process.env.HAPI_GENERATED_MEDIA_CACHE_DIR
            else process.env.HAPI_GENERATED_MEDIA_CACHE_DIR = prevOverride
            await rm(burstHome, { recursive: true, force: true })
        }
    })
})
