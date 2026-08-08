import { describe, expect, it, vi } from 'vitest'
import {
    buildSharePayloadFromDeepLink,
    buildSharePayloadFromFormData,
    buildSharePayloadFromSearchFields,
    hasShareDeepLinkContent,
    ingestShareRequest,
    parseShareDeepLinkFields,
    parseShareHash,
    parseShareSearch,
    type ShareTransferPayload,
} from './shareTransfer'

describe('buildSharePayloadFromFormData', () => {
    it('extracts text-only share with empty file list', async () => {
        const fd = new FormData()
        fd.set('title', 'My note')
        fd.set('text', 'Hello world')
        fd.set('url', 'https://example.com/page')

        const payload = await buildSharePayloadFromFormData(fd, 1700000000000)

        expect(payload).toEqual({
            title: 'My note',
            text: 'Hello world',
            url: 'https://example.com/page',
            files: [],
            createdAt: 1700000000000,
        })
    })

    it('falls back to empty strings when fields are missing', async () => {
        const fd = new FormData()
        const payload = await buildSharePayloadFromFormData(fd, 42)

        expect(payload.title).toBe('')
        expect(payload.text).toBe('')
        expect(payload.url).toBe('')
        expect(payload.files).toEqual([])
        expect(payload.createdAt).toBe(42)
    })

    it('extracts a single image file with type', async () => {
        const fd = new FormData()
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
        fd.append('files', file)

        const payload = await buildSharePayloadFromFormData(fd)

        expect(payload.files).toHaveLength(1)
        expect(payload.files[0]).toMatchObject({
            name: 'photo.png',
            type: 'image/png',
        })
        expect(payload.files[0].blob).toBeInstanceOf(Blob)
    })

    it('handles multi-file shares preserving order', async () => {
        const fd = new FormData()
        const a = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' })
        const b = new File([new Uint8Array([2])], 'b.pdf', { type: 'application/pdf' })
        const c = new File([new Uint8Array([3])], 'c.bin', { type: '' })
        fd.append('files', a)
        fd.append('files', b)
        fd.append('files', c)

        const payload = await buildSharePayloadFromFormData(fd)

        expect(payload.files.map((f) => f.name)).toEqual(['a.txt', 'b.pdf', 'c.bin'])
        // Empty mime should fall back to application/octet-stream so the
        // downstream uploader doesn't choke on Content-Type: ''.
        expect(payload.files[2].type).toBe('application/octet-stream')
    })

    it('ignores non-File entries under the "files" key', async () => {
        const fd = new FormData()
        fd.append('files', 'stringy not a file')
        const file = new File([new Uint8Array([0])], 'real.txt', { type: 'text/plain' })
        fd.append('files', file)

        const payload = await buildSharePayloadFromFormData(fd)

        expect(payload.files).toHaveLength(1)
        expect(payload.files[0].name).toBe('real.txt')
    })
})

describe('parseShareSearch', () => {
    it('keeps id and error as today', () => {
        expect(parseShareSearch({ id: 'xfer-1', error: 'ingest' })).toEqual({
            id: 'xfer-1',
            error: 'ingest',
        })
    })

    it('ignores url/text/title in the query (content belongs in the fragment)', () => {
        expect(parseShareSearch({
            id: 'xfer-1',
            url: 'https://example.com',
            text: 'hello',
            title: 'Title',
        })).toEqual({ id: 'xfer-1' })
    })
})

describe('parseShareHash / parseShareDeepLinkFields', () => {
    it('parses url, text, and title from a fragment', () => {
        expect(parseShareHash('#url=https%3A%2F%2Fexample.com&text=hello&title=Title')).toEqual({
            url: 'https://example.com',
            text: 'hello',
            title: 'Title',
        })
    })

    it('accepts a hash without a leading #', () => {
        expect(parseShareHash('text=note')).toEqual({ text: 'note' })
    })

    it('omits empty content fields', () => {
        expect(parseShareDeepLinkFields({ url: '', text: '  ', title: '' })).toEqual({})
    })

    it('preserves surrounding whitespace on non-empty content fields', () => {
        expect(parseShareDeepLinkFields({
            title: '  Title  ',
            text: '    indented\n',
            url: ' https://example.com/path ',
        })).toEqual({
            title: '  Title  ',
            text: '    indented\n',
            url: ' https://example.com/path ',
        })
    })
})

describe('hasShareDeepLinkContent', () => {
    it('is true for url-only', () => {
        expect(hasShareDeepLinkContent({ url: 'https://a.example' })).toBe(true)
    })

    it('is true for text-only', () => {
        expect(hasShareDeepLinkContent({ text: 'note' })).toBe(true)
    })

    it('is true when both url and text are set', () => {
        expect(hasShareDeepLinkContent({
            url: 'https://a.example',
            text: 'note',
        })).toBe(true)
    })

    it('is false when empty', () => {
        expect(hasShareDeepLinkContent({})).toBe(false)
    })

    it('is true when fileUrl is present', () => {
        expect(hasShareDeepLinkContent({
            fileUrl: 'http://127.0.0.1:9/s',
        })).toBe(true)
    })
})

describe('buildSharePayloadFromSearchFields', () => {
    it('builds the same text payload shape as form-data (url-only)', () => {
        expect(buildSharePayloadFromSearchFields(
            { url: 'https://example.com/page' },
            1700000000000,
        )).toEqual({
            title: '',
            text: '',
            url: 'https://example.com/page',
            files: [],
            createdAt: 1700000000000,
        })
    })

    it('builds text-only payload', () => {
        expect(buildSharePayloadFromSearchFields(
            { text: 'Hello world' },
            42,
        )).toEqual({
            title: '',
            text: 'Hello world',
            url: '',
            files: [],
            createdAt: 42,
        })
    })

    it('builds combined title+text+url payload', () => {
        expect(buildSharePayloadFromSearchFields({
            title: 'My note',
            text: 'Hello world',
            url: 'https://example.com/page',
        }, 99)).toEqual({
            title: 'My note',
            text: 'Hello world',
            url: 'https://example.com/page',
            files: [],
            createdAt: 99,
        })
    })
})

describe('buildSharePayloadFromDeepLink', () => {
    it('fetches fileUrl into files[]', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4])
        const fetchMock = vi.fn(async () => new Response(bytes, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        }))
        const payload = await buildSharePayloadFromDeepLink(
            {
                title: 'Shot',
                fileUrl: 'http://127.0.0.1:9/once',
                fileName: 'shot.jpg',
                fileType: 'image/jpeg',
            },
            55,
            { fetch: fetchMock as unknown as typeof fetch },
        )
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9/once')
        expect(payload.title).toBe('Shot')
        expect(payload.files).toHaveLength(1)
        expect(payload.files[0]).toMatchObject({
            name: 'shot.jpg',
            type: 'image/jpeg',
        })
        expect(payload.files[0].blob.size).toBe(4)
        expect(payload.createdAt).toBe(55)
    })

    it('throws when fileUrl fetch fails', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
        await expect(buildSharePayloadFromDeepLink(
            { fileUrl: 'http://127.0.0.1:9/missing' },
            1,
            { fetch: fetchMock as unknown as typeof fetch },
        )).rejects.toThrow(/fileUrl fetch failed/)
    })

    it('rejects when Content-Length exceeds the upload ceiling', async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), {
            status: 200,
            headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(51 * 1024 * 1024),
            },
        }))
        await expect(buildSharePayloadFromDeepLink(
            { fileUrl: 'http://127.0.0.1:9/huge' },
            1,
            { fetch: fetchMock as unknown as typeof fetch },
        )).rejects.toThrow(/too large/)
    })

    it('rejects when streamed body exceeds the upload ceiling', async () => {
        const chunk = new Uint8Array(1024 * 1024)
        let reads = 0
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                reads += 1
                if (reads <= 51) {
                    controller.enqueue(chunk)
                    return
                }
                controller.close()
            },
        })
        const fetchMock = vi.fn(async () => new Response(stream, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
        }))
        await expect(buildSharePayloadFromDeepLink(
            { fileUrl: 'http://127.0.0.1:9/stream' },
            1,
            { fetch: fetchMock as unknown as typeof fetch },
        )).rejects.toThrow(/too large/)
    })
})

describe('ingestShareRequest', () => {
    // jsdom/undici loses File objects when serializing FormData through
    // `new Request({ body })` and re-parsing via `request.formData()`. The
    // production SW only invokes Request#formData() once on the inbound
    // multipart frame; tests substitute a stub that returns the FormData
    // directly so the path under test (form -> payload -> put -> redirect)
    // is exercised without depending on multipart roundtrip fidelity.
    function makeRequest(formData: FormData): Request {
        return {
            formData: () => Promise.resolve(formData),
        } as unknown as Request
    }

    it('persists payload via the put dep and returns a /share?id=… redirect', async () => {
        const fd = new FormData()
        fd.set('title', 'shared')
        fd.append('files', new File([new Uint8Array([7])], 'a.bin', { type: '' }))

        const put = vi.fn<(payload: ShareTransferPayload) => Promise<string>>()
            .mockResolvedValue('xfer-abc')

        const result = await ingestShareRequest(makeRequest(fd), {
            put,
            now: () => 9999,
        })

        expect(put).toHaveBeenCalledTimes(1)
        const arg = put.mock.calls[0][0]
        expect(arg.title).toBe('shared')
        expect(arg.files).toHaveLength(1)
        expect(arg.createdAt).toBe(9999)
        expect(result.redirectTo).toBe('/share?id=xfer-abc')
    })

    it('encodes the transfer id so it survives querystring placement', async () => {
        const put = vi.fn<(payload: ShareTransferPayload) => Promise<string>>()
            .mockResolvedValue('contains spaces & ampersands')

        const result = await ingestShareRequest(makeRequest(new FormData()), { put })

        expect(result.redirectTo).toBe('/share?id=contains%20spaces%20%26%20ampersands')
    })

    it('propagates put rejections so the SW can fall back to error redirect', async () => {
        const put = vi.fn<(payload: ShareTransferPayload) => Promise<string>>()
            .mockRejectedValue(new Error('quota exceeded'))

        await expect(
            ingestShareRequest(makeRequest(new FormData()), { put })
        ).rejects.toThrow('quota exceeded')
    })
})
