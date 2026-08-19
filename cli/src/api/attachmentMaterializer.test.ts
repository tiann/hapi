import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

const axiosGet = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        get: axiosGet
    }
}))

import { AttachmentMaterializer } from './attachmentMaterializer'

const attachment = {
    id: 'message-attachment-1',
    attachmentId: 'attachment-1',
    filename: 'photo.png',
    mimeType: 'image/png',
    size: 4
}

afterEach(() => {
    axiosGet.mockReset()
})

describe('AttachmentMaterializer', () => {
    it('downloads, validates, caches, and cleans an original', async () => {
        const data = Buffer.from('hub bytes')
        axiosGet.mockResolvedValue({
            data,
            headers: {
                'content-length': String(data.length),
                'x-hapi-attachment-size': String(data.length),
                'x-hapi-attachment-sha256': createHash('sha256').update(data).digest('hex')
            }
        })
        const materializer = new AttachmentMaterializer('session-1', 'token')

        const first = await materializer.materialize(attachment)
        const second = await materializer.materialize(attachment)
        expect(first.path).toBe(second.path)
        expect(first.path).toBeTruthy()
        expect(readFileSync(first.path!)).toEqual(data)
        expect(materializer.isAuthorizedPath(first.path!)).toBe(true)
        expect(materializer.isAuthorizedFile(first.path!, statSync(first.path!))).toBe(true)
        expect(materializer.isAuthorizedFile(first.path!, { dev: 0, ino: 0 })).toBe(false)
        expect(axiosGet).toHaveBeenCalledTimes(1)

        const path = first.path!
        await materializer.close()
        expect(existsSync(path)).toBe(false)
        expect(materializer.isAuthorizedPath(path)).toBe(false)
    })

    it('shares one session directory across concurrent first-use downloads', async () => {
        axiosGet.mockImplementation(async (url: string) => ({
            data: Buffer.from(url.endsWith('attachment-1/original') ? 'first' : 'second'),
            headers: {}
        }))
        const materializer = new AttachmentMaterializer('session-1', 'token')

        const [first, second] = await Promise.all([
            materializer.materialize({ ...attachment, attachmentId: 'attachment-1' }),
            materializer.materialize({ ...attachment, attachmentId: 'attachment-2' })
        ])

        expect(dirname(first.path!)).toBe(dirname(second.path!))
        expect(readFileSync(first.path!)).toEqual(Buffer.from('first'))
        expect(readFileSync(second.path!)).toEqual(Buffer.from('second'))
        const firstPath = first.path!
        const secondPath = second.path!
        await materializer.close()
        expect(existsSync(firstPath)).toBe(false)
        expect(existsSync(secondPath)).toBe(false)
    })

    it('rejects a hash mismatch without returning a local path', async () => {
        const data = Buffer.from('hub bytes')
        axiosGet.mockResolvedValue({
            data,
            headers: { 'x-hapi-attachment-sha256': 'wrong' }
        })
        const materializer = new AttachmentMaterializer('session-1', 'token')

        await expect(materializer.materialize(attachment)).rejects.toThrow('integrity')
        await materializer.close()
    })

    it('keeps untrusted attachment identifiers inside the session directory', async () => {
        const data = Buffer.from('hub bytes')
        axiosGet.mockResolvedValue({
            data,
            headers: { 'x-hapi-attachment-sha256': createHash('sha256').update(data).digest('hex') }
        })
        const materializer = new AttachmentMaterializer('../session', 'token')

        const result = await materializer.materialize({
            ...attachment,
            attachmentId: '../escape/attachment'
        })
        expect(basename(result.path!)).toBe('.._escape_attachment.png')
        expect(readFileSync(result.path!)).toEqual(data)
        await materializer.close()
    })
})
