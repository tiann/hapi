import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()

vi.mock('./query', () => ({
    query: (config: unknown) => queryMock(config)
}))

function fakeInitQuery() {
    return (async function* () {
        yield {
            type: 'system',
            subtype: 'init',
            tools: ['Bash'],
            slash_commands: ['/help']
        }
    })()
}

describe('extractSDKMetadata', () => {
    it('captures tools and slash commands from the init message', async () => {
        queryMock.mockImplementation(fakeInitQuery)

        const { extractSDKMetadata } = await import('./metadataExtractor')
        const metadata = await extractSDKMetadata()

        expect(metadata).toEqual({ tools: ['Bash'], slashCommands: ['/help'] })
    })

    it('runs the extraction query in a temp cwd outside the user project (#250)', async () => {
        queryMock.mockImplementation(fakeInitQuery)

        const { extractSDKMetadata } = await import('./metadataExtractor')
        await extractSDKMetadata()

        const config = queryMock.mock.calls[0][0] as { options: { cwd: string } }
        expect(config.options.cwd).toBe(join(tmpdir(), 'hapi-sdk-metadata'))
        expect(existsSync(config.options.cwd)).toBe(true)
    })
})
