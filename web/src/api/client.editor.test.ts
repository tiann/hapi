import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

describe('ApiClient editor file mutations', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('posts editor write-file requests', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ success: true, path: '/repo/a.ts', size: 7 })
        } as Response)
        const api = new ApiClient('token')

        await expect(api.writeEditorFile('machine-1', '/repo/a.ts', 'updated')).resolves.toEqual({
            success: true,
            path: '/repo/a.ts',
            size: 7
        })

        expect(fetchMock).toHaveBeenCalledWith('/api/editor/file/write', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ machineId: 'machine-1', path: '/repo/a.ts', content: 'updated' })
        }))
    })

    it('posts editor create-file requests', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ success: true, path: '/repo/new.ts', size: 0 })
        } as Response)
        const api = new ApiClient('token')

        await expect(api.createEditorFile('machine-1', '/repo/new.ts', '')).resolves.toEqual({
            success: true,
            path: '/repo/new.ts',
            size: 0
        })

        expect(fetchMock).toHaveBeenCalledWith('/api/editor/file/create', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ machineId: 'machine-1', path: '/repo/new.ts', content: '' })
        }))
    })
})
