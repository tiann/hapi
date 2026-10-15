import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { clearGeneratedImages, registerGeneratedImage } from '../generatedImages'
import { registerFileHandlers } from './files'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-file-handler')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
        clearGeneratedImages()
    })

    it('returns file metadata alongside content', async () => {
        const filePath = join(rootDir, 'README.md')
        await writeFile(filePath, '# test')
        const expectedStats = await stat(filePath)

        const response = await rpc.handleRequest({
            method: 'session-test:readFile',
            params: JSON.stringify({ path: 'README.md' })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            content?: string
            size?: number
            modified?: number
        }

        expect(parsed.success).toBe(true)
        expect(parsed.content).toBe(Buffer.from('# test').toString('base64'))
        expect(parsed.size).toBe(expectedStats.size)
        expect(parsed.modified).toBe(expectedStats.mtime.getTime())
    })

    it('returns generated image metadata without content when requested', async () => {
        const bytes = Buffer.from('generated file')
        registerGeneratedImage({
            id: 'generated-metadata-test',
            path: join(rootDir, 'archive.zip'),
            mimeType: 'application/octet-stream',
            bytes,
            fileName: 'archive.zip'
        })

        const response = await rpc.handleRequest({
            method: 'session-test:readGeneratedImage',
            params: JSON.stringify({ id: 'generated-metadata-test', metadataOnly: true })
        })
        const parsed = JSON.parse(response) as {
            success: boolean
            content?: string
            size?: number
            fileName?: string
        }

        expect(parsed.success).toBe(true)
        expect(parsed.content).toBeUndefined()
        expect(parsed.size).toBe(bytes.byteLength)
        expect(parsed.fileName).toBe('archive.zip')
    })
})
