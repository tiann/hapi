import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { HapiSessionExport, HapiSessionExportWarning } from '@hapi/protocol/sessionExport'
import {
    downloadSessionExport,
    type SessionExportDownloadResult
} from './download'

function makePayload(): HapiSessionExport {
    return {
        schemaVersion: 2,
        exportedAt: Date.UTC(2026, 5, 5, 12, 0, 0),
        session: {
            id: 'session-abcdef123456',
            namespace: 'default',
            seq: 1,
            createdAt: Date.UTC(2026, 5, 5, 10, 0, 0),
            updatedAt: Date.UTC(2026, 5, 5, 12, 0, 0),
            active: false,
            activeAt: 1,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                name: 'Large session'
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 1,
            model: null,
            modelReasoningEffort: null,
            effort: null,
            serviceTier: null,
            permissionMode: 'default',
            collaborationMode: 'default'
        },
        messages: [],
        scratchlist: []
    }
}

function makeApi(response: HapiSessionExport | HapiSessionExportWarning) {
    return {
        getSessionExport: vi.fn().mockResolvedValue(response)
    } as unknown as ApiClient
}

describe('downloadSessionExport', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:session-export')
    const revokeObjectURL = vi.fn()

    beforeEach(() => {
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: createObjectURL
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: revokeObjectURL
        })
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
        createObjectURL.mockClear()
        revokeObjectURL.mockClear()
    })

    it('returns the warning without creating a file download', async () => {
        const warning: HapiSessionExportWarning = {
            type: 'warning',
            count: 20_001,
            limit: 20_000,
            estimatedBytes: 12_345_678
        }
        const api = makeApi(warning)

        const result = await downloadSessionExport(api, 'session-1', 'json')

        expect(result).toEqual({ type: 'warning', warning })
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    })

    it('downloads confirmed JSON exactly once', async () => {
        const api = makeApi(makePayload())

        const result = await downloadSessionExport(api, 'session-1', 'json', { force: true })

        expect((result as SessionExportDownloadResult).type).toBe('downloaded')
        expect(api.getSessionExport).toHaveBeenCalledWith('session-1', { force: true, signal: undefined })
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
        const blob = createObjectURL.mock.calls[0]?.[0] as Blob
        expect(blob.type).toBe('application/json;charset=utf-8')
        expect(result.type).toBe('downloaded')
        if (result.type !== 'downloaded') throw new Error('Expected JSON download')
        expect(result.filename).toMatch(/\.json$/)
    })

    it('downloads confirmed Markdown exactly once', async () => {
        const api = makeApi(makePayload())

        const result = await downloadSessionExport(api, 'session-1', 'markdown', { force: true })

        expect((result as SessionExportDownloadResult).type).toBe('downloaded')
        expect(api.getSessionExport).toHaveBeenCalledWith('session-1', { force: true, signal: undefined })
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
        const blob = createObjectURL.mock.calls[0]?.[0] as Blob
        expect(blob.type).toBe('text/markdown;charset=utf-8')
        expect(result.type).toBe('downloaded')
        if (result.type !== 'downloaded') throw new Error('Expected Markdown download')
        expect(result.filename).toMatch(/\.md$/)
    })
})
