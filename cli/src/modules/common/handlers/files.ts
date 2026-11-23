import { logger } from '@/ui/logger'
import { readFile, realpath, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { FileReadResponse, GeneratedImageResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getGeneratedImage, readBoundedRegularFile } from '../generatedImages'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
    maxBytes?: number
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

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

async function resolveReadablePath(path: string, workingDirectory: string): Promise<string> {
    const [realWorkingDirectory, realPath] = await Promise.all([
        realpath(workingDirectory),
        realpath(path),
    ])
    const relativePath = relative(realWorkingDirectory, realPath)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('Access denied: resolved path is outside the working directory')
    }
    return realPath
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            const resolvedPath = await resolveReadablePath(resolve(workingDirectory, data.path), workingDirectory)
            const maxBytes = typeof data.maxBytes === 'number' && Number.isFinite(data.maxBytes) && data.maxBytes > 0
                ? Math.min(Math.floor(data.maxBytes), 10 * 1024 * 1024)
                : undefined
            const stats = maxBytes === undefined ? await stat(resolvedPath) : undefined
            const buffer = maxBytes === undefined
                ? await readFile(resolvedPath)
                : await readBoundedRegularFile(resolvedPath, maxBytes)
            const finalStats = maxBytes === undefined ? stats! : await stat(resolvedPath)
            const content = buffer.toString('base64')
            return {
                success: true,
                content,
                size: finalStats.size,
                modified: finalStats.mtime.getTime()
            }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(data.path)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(data.path, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
