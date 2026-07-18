import { logger } from '@/ui/logger'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'crypto'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getErrorMessage, rpcError } from '../rpcResponses'

const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0

interface ReadFileRequest {
    path: string
}

interface ReadFileResponse {
    success: boolean
    content?: string
    error?: string
}

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = await validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const handle = await open(validation.resolvedPath!, constants.O_RDONLY | NOFOLLOW_FLAG)
            let buffer: Buffer
            try {
                const stats = await handle.stat()
                if (!stats.isFile()) {
                    return rpcError('Path is not a regular file')
                }
                buffer = await handle.readFile()
            } finally {
                await handle.close()
            }
            const content = buffer.toString('base64')
            return { success: true, content }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path)

        const hasExpectedHash = data.expectedHash !== null && data.expectedHash !== undefined
        const validation = await validatePath(data.path, workingDirectory, {
            allowMissingLeaf: !hasExpectedHash,
        })
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const buffer = Buffer.from(data.content, 'base64')
            if (hasExpectedHash) {
                let handle
                try {
                    handle = await open(validation.resolvedPath!, constants.O_RDWR | NOFOLLOW_FLAG)
                    const stats = await handle.stat()
                    if (!stats.isFile()) {
                        return rpcError('Path is not a regular file')
                    }
                    const existingBuffer = await handle.readFile()
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }

                    await handle.write(buffer, 0, buffer.length, 0)
                    await handle.truncate(buffer.length)
                    await handle.sync()
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                } finally {
                    await handle?.close()
                }
            } else {
                let handle
                try {
                    handle = await open(
                        validation.resolvedPath!,
                        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
                        0o666,
                    )
                    await handle.writeFile(buffer)
                    await handle.sync()
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code === 'EEXIST') {
                        return rpcError('File already exists but was expected to be new')
                    }
                    throw error
                } finally {
                    await handle?.close()
                }
            }

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
