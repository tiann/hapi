import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeHelperPath } from './localHelper'
import { logger } from '@/ui/logger'

const execFileAsync = promisify(execFile)
let loggedMissingHelper = false

export type NativeDirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
    isGitRepo?: boolean
}

export type NativeListDirectoryResponse = {
    success: boolean
    entries?: NativeDirectoryEntry[]
    error?: string
}

export type NativeReadFileResponse = {
    success: boolean
    content?: string
    error?: string
}

export type NativeWriteFileResponse = {
    success: boolean
    hash?: string
    error?: string
}

export type NativeTreeNode = {
    name: string
    path: string
    type: 'file' | 'directory'
    size?: number
    modified?: number
    children?: NativeTreeNode[]
}

export type NativeDirectoryTreeResponse = {
    success: boolean
    tree?: NativeTreeNode
    error?: string
}

function errorOutput(error: unknown): string {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    return [err.stderr, err.stdout, err.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n')
        .trim()
}

function logMissingHelper(): void {
    if (loggedMissingHelper) return
    loggedMissingHelper = true
    logger.debug('[native] hapi-local not found; using TypeScript filesystem fallback')
}

function logUnsupported(action: string, output: string): void {
    logger.debug(`[native] hapi-local fs ${action} unsupported; using TypeScript fallback`, output)
}

export async function nativeListDirectory(options: {
    root: string
    path: string
    includeGit?: boolean
    hideDot?: boolean
}): Promise<NativeListDirectoryResponse | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    const args = [
        'fs',
        'list-dir',
        '--root',
        options.root,
        '--path',
        options.path || '.',
        ...(options.includeGit ? ['--include-git'] : []),
        ...(options.hideDot ? ['--hide-dot'] : [])
    ]

    try {
        const { stdout } = await execFileAsync(helper, args, { encoding: 'utf8' })
        return JSON.parse(stdout) as NativeListDirectoryResponse
    } catch (error) {
        const output = errorOutput(error)
        if (output.includes('unknown command') || output.includes('unknown fs action')) {
            logUnsupported('list-dir', output)
            return null
        }
        return { success: false, error: output || 'Failed to list directory' }
    }
}

export async function nativeDirectoryTree(options: {
    root: string
    path: string
    maxDepth: number
}): Promise<NativeDirectoryTreeResponse | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    try {
        const { stdout } = await execFileAsync(helper, [
            'fs',
            'tree',
            '--root',
            options.root,
            '--path',
            options.path || '.',
            '--max-depth',
            String(options.maxDepth)
        ], { encoding: 'utf8' })
        return JSON.parse(stdout) as NativeDirectoryTreeResponse
    } catch (error) {
        const output = errorOutput(error)
        if (output.includes('unknown command') || output.includes('unknown fs action')) {
            logUnsupported('tree', output)
            return null
        }
        return { success: false, error: output || 'Failed to get directory tree' }
    }
}

export async function nativeReadFile(options: {
    root: string
    path: string
}): Promise<NativeReadFileResponse | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    try {
        const { stdout } = await execFileAsync(helper, [
            'fs',
            'read-file',
            '--root',
            options.root,
            '--path',
            options.path
        ], { encoding: 'utf8' })
        return JSON.parse(stdout) as NativeReadFileResponse
    } catch (error) {
        const output = errorOutput(error)
        if (output.includes('unknown command') || output.includes('unknown fs action')) {
            logUnsupported('read-file', output)
            return null
        }
        return { success: false, error: output || 'Failed to read file' }
    }
}

export async function nativeWriteFile(options: {
    root: string
    path: string
    content: string
    expectedHash?: string | null
}): Promise<NativeWriteFileResponse | null> {
    const helper = nativeHelperPath()
    if (!helper) {
        logMissingHelper()
        return null
    }

    const args = [
        'fs',
        'write-file',
        '--root',
        options.root,
        '--path',
        options.path,
        '--content',
        options.content,
        ...(options.expectedHash !== null && options.expectedHash !== undefined
            ? ['--expected-hash', options.expectedHash]
            : [])
    ]

    try {
        const { stdout } = await execFileAsync(helper, args, { encoding: 'utf8' })
        return JSON.parse(stdout) as NativeWriteFileResponse
    } catch (error) {
        const output = errorOutput(error)
        if (output.includes('unknown command') || output.includes('unknown fs action')) {
            logUnsupported('write-file', output)
            return null
        }
        return { success: false, error: output || 'Failed to write file' }
    }
}
