import { beforeEach, describe, expect, it, vi } from 'vitest'
import { safeCopyToClipboard } from './clipboard'

describe('safeCopyToClipboard', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            writable: true,
            value: vi.fn(() => false)
        })
    })

    it('uses navigator clipboard writeText when available', async () => {
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(true)

        await safeCopyToClipboard('hello')

        expect(writeText).toHaveBeenCalledWith('hello')
        expect(execCommand).not.toHaveBeenCalled()
    })

    it('falls back to execCommand when clipboard api write fails', async () => {
        const writeText = vi.fn(async () => {
            throw new Error('clipboard denied')
        })
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(true)

        await safeCopyToClipboard('fallback')

        expect(writeText).toHaveBeenCalledWith('fallback')
        expect(execCommand).toHaveBeenCalledWith('copy')
    })

    it('throws when both modern and legacy copy strategies fail', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: undefined
        })
        const execCommand = vi.mocked(document.execCommand)
        execCommand.mockReturnValue(false)

        await expect(safeCopyToClipboard('x')).rejects.toThrow('Copy to clipboard failed')
    })
})
