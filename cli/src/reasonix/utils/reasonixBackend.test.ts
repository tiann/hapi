import { afterEach, describe, expect, it, vi } from 'vitest'

const constructor = vi.fn()

vi.mock('@/agent/backends/acp', () => ({
    AcpSdkBackend: function (options: unknown) {
        constructor(options)
    }
}))

import { createReasonixBackend } from './reasonixBackend'

describe('createReasonixBackend', () => {
    afterEach(() => {
        delete process.env.REASONIX_CLI_PATH
        constructor.mockClear()
    })

    it('launches the Reasonix ACP stdio endpoint with delta chunks', () => {
        createReasonixBackend()

        expect(constructor).toHaveBeenCalledWith(expect.objectContaining({
            command: 'reasonix',
            args: ['acp'],
            flavor: 'reasonix',
            textChunkMode: 'delta'
        }))
    })

    it('honors REASONIX_CLI_PATH for non-PATH installations', () => {
        process.env.REASONIX_CLI_PATH = '/opt/reasonix/bin/reasonix'

        createReasonixBackend()

        expect(constructor).toHaveBeenCalledWith(expect.objectContaining({
            command: '/opt/reasonix/bin/reasonix'
        }))
    })
})
