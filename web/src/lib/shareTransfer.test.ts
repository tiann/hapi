import { describe, expect, it, vi } from 'vitest'
import {
    buildSharePayloadFromFormData,
    ingestShareRequest,
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
