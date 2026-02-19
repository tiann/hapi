import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'

mock.module('node:fs', () => ({
    existsSync: mock(),
    mkdirSync: mock(),
}))

mock.module('node:fs/promises', () => ({
    readFile: mock(),
    writeFile: mock(),
    rename: mock(),
    mkdir: mock(),
    chmod: mock(),
}))

// Import after mocks
import { getOrCreateCliApiToken } from './cliApiToken'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('cliApiToken', () => {
    const dataDir = join(tmpdir(), 'hapi-test-' + Math.random().toString(36).slice(2))

    beforeEach(() => {
        process.env.CLI_API_TOKEN = ''
    })

    afterEach(() => {
        delete process.env.CLI_API_TOKEN
    })

    it('should throw Error if CLI_API_TOKEN from env is weak', async () => {
        process.env.CLI_API_TOKEN = 'weak'

        // @ts-ignore
        fsPromises.readFile.mockResolvedValue('{}')
        // @ts-ignore
        fs.existsSync.mockReturnValue(true)

        expect(getOrCreateCliApiToken(dataDir)).rejects.toThrow('CLI_API_TOKEN is too weak')
    })

    it('should throw Error if CLI_API_TOKEN from settings.json is weak', async () => {
        // @ts-ignore
        fsPromises.readFile.mockResolvedValue(JSON.stringify({ cliApiToken: 'weak-in-file' }))
        // @ts-ignore
        fs.existsSync.mockReturnValue(true)

        expect(getOrCreateCliApiToken(dataDir)).rejects.toThrow('Saved CLI API token in settings.json is too weak')
    })

    it('should allow strong CLI_API_TOKEN from env', async () => {
        const strongToken = 'a-very-strong-token-that-is-long-enough'
        process.env.CLI_API_TOKEN = strongToken

        // @ts-ignore
        fsPromises.readFile.mockResolvedValue('{}')
        // @ts-ignore
        fs.existsSync.mockReturnValue(true)
        // @ts-ignore
        fsPromises.writeFile.mockResolvedValue(undefined)
        // @ts-ignore
        fsPromises.rename.mockResolvedValue(undefined)

        const result = await getOrCreateCliApiToken(dataDir)
        expect(result.token).toBe(strongToken)
        expect(result.source).toBe('env')
    })

    it('should allow strong CLI_API_TOKEN from settings.json', async () => {
        const strongToken = 'another-strong-token-from-file-system'
        // @ts-ignore
        fsPromises.readFile.mockResolvedValue(JSON.stringify({ cliApiToken: strongToken }))
        // @ts-ignore
        fs.existsSync.mockReturnValue(true)

        const result = await getOrCreateCliApiToken(dataDir)
        expect(result.token).toBe(strongToken)
        expect(result.source).toBe('file')
    })

    it('should auto-generate strong token if none exists', async () => {
        // @ts-ignore
        fsPromises.readFile.mockResolvedValue('{}')
        // @ts-ignore
        fs.existsSync.mockReturnValue(true)
        // @ts-ignore
        fsPromises.writeFile.mockResolvedValue(undefined)
        // @ts-ignore
        fsPromises.rename.mockResolvedValue(undefined)

        const result = await getOrCreateCliApiToken(dataDir)
        expect(result.token.length).toBeGreaterThan(32)
        expect(result.source).toBe('generated')
    })
})
