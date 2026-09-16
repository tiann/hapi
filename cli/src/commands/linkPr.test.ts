import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    axiosPostMock,
    getAuthTokenMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    axiosPostMock: vi.fn(async () => ({ status: 200, data: { ok: true } })),
    getAuthTokenMock: vi.fn(() => 'test-token')
}))

vi.mock('@/ui/tokenInit', () => ({ initializeToken: initializeTokenMock }))
vi.mock('@/api/auth', () => ({ getAuthToken: getAuthTokenMock }))
vi.mock('axios', () => ({
    default: {
        post: axiosPostMock
    }
}))
vi.mock('@/api/hubExtraHeaders', () => ({
    buildHubRequestHeaders: (headers: Record<string, string>) => headers
}))

import { linkPrCommand } from './linkPr'

function createCommandContext(commandArgs: string[]) {
    return {
        args: ['link-pr', ...commandArgs],
        commandArgs
    }
}

describe('linkPrCommand', () => {
    beforeEach(() => {
        initializeTokenMock.mockClear()
        axiosPostMock.mockClear()
        getAuthTokenMock.mockClear()
        process.env.HAPI_SESSION_ID = '11111111-2222-3333-4444-555555555555'
    })

    it('does not initialize token for --help', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code ?? 0}`)
        }) as never)

        await expect(linkPrCommand.run(createCommandContext([
            'https://github.com/tiann/hapi/pull/1163',
            '--help'
        ]))).rejects.toThrow('exit:0')

        expect(initializeTokenMock).not.toHaveBeenCalled()
        expect(axiosPostMock).not.toHaveBeenCalled()
        exitSpy.mockRestore()
    })

    it('initializes token before contacting the hub', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

        await linkPrCommand.run(createCommandContext([
            'https://github.com/tiann/hapi/pull/1163'
        ]))

        expect(initializeTokenMock).toHaveBeenCalledOnce()
        expect(axiosPostMock).toHaveBeenCalledOnce()
        expect(initializeTokenMock.mock.invocationCallOrder[0]!).toBeLessThan(
            axiosPostMock.mock.invocationCallOrder[0]!
        )
        logSpy.mockRestore()
    })
})
