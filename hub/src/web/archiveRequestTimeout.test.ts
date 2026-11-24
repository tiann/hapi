import { describe, expect, it, mock } from 'bun:test'
import {
    ARCHIVE_REQUEST_IDLE_TIMEOUT_SEC,
    maybeExtendArchiveRequestTimeout,
} from './archiveRequestTimeout'

describe('maybeExtendArchiveRequestTimeout', () => {
    it('extends idle timeout for POST /api/sessions/:id/archive', () => {
        const timeout = mock((_req: Request, _seconds: number) => {})
        const req = new Request('http://hub.test/api/sessions/sess-1/archive', { method: 'POST' })
        expect(maybeExtendArchiveRequestTimeout(req, { timeout })).toBe(true)
        expect(timeout).toHaveBeenCalledTimes(1)
        expect(timeout.mock.calls[0]?.[1]).toBe(ARCHIVE_REQUEST_IDLE_TIMEOUT_SEC)
        expect(ARCHIVE_REQUEST_IDLE_TIMEOUT_SEC).toBeGreaterThanOrEqual(90)
    })

    it('ignores non-archive routes and methods', () => {
        const timeout = mock((_req: Request, _seconds: number) => {})
        expect(maybeExtendArchiveRequestTimeout(
            new Request('http://hub.test/api/sessions/sess-1/archive', { method: 'GET' }),
            { timeout },
        )).toBe(false)
        expect(maybeExtendArchiveRequestTimeout(
            new Request('http://hub.test/api/sessions/sess-1/abort', { method: 'POST' }),
            { timeout },
        )).toBe(false)
        expect(timeout).not.toHaveBeenCalled()
    })
})
