import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard'
import { cursorLocal } from './cursorLocal'

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: vi.fn(async () => undefined),
}))

const originalCursorPath = process.env.HAPI_CURSOR_PATH

describe('cursorLocal command resolution', () => {
    beforeEach(() => {
        ;(spawnWithTerminalGuard as unknown as { mockClear: () => void }).mockClear()
        delete process.env.HAPI_CURSOR_PATH
    })

    afterEach(() => {
        if (originalCursorPath === undefined) {
            delete process.env.HAPI_CURSOR_PATH
        } else {
            process.env.HAPI_CURSOR_PATH = originalCursorPath
        }
    })

    it('launches cursor-agent rather than the ambiguous generic agent command', async () => {
        await cursorLocal({
            abort: new AbortController().signal,
            chatId: null,
            path: '/tmp/project',
        })

        const call = (spawnWithTerminalGuard as unknown as { mock: { calls: Array<[{
            command: string
            spawnName: string
        }]> } }).mock.calls.at(-1)?.[0]
        expect(call?.command).toBe('cursor-agent')
        expect(call?.spawnName).toBe('cursor-agent')
    })

    it('uses an explicit HAPI_CURSOR_PATH override', async () => {
        process.env.HAPI_CURSOR_PATH = '/opt/cursor-agent'

        await cursorLocal({
            abort: new AbortController().signal,
            chatId: null,
            path: '/tmp/project',
        })

        const call = (spawnWithTerminalGuard as unknown as { mock: { calls: Array<[{
            command: string
        }]> } }).mock.calls.at(-1)?.[0]
        expect(call?.command).toBe('/opt/cursor-agent')
    })
})
