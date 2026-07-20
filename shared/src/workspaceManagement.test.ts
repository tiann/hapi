import { describe, expect, it } from 'vitest'
import {
    FileOperationSchema,
    GitOperationSchema,
    HostFileUploadRequestSchema,
    HostFileWriteRequestSchema,
    MAX_HOST_FILE_TEXT_BYTES
} from './workspaceManagement'

describe('workspace management schemas', () => {
    it('accepts copy conflict policies and Git branch lifecycle operations', () => {
        expect(FileOperationSchema.safeParse({
            kind: 'copy',
            sources: ['/workspace/a.txt'],
            destination: '/workspace/destination',
            conflict: 'new-copy',
            createDestination: true
        }).success).toBe(true)
        expect(GitOperationSchema.safeParse({
            kind: 'create-branch',
            repository: '/workspace/repository',
            name: 'feature/workspace-controls',
            startPoint: 'origin/main',
            switchTo: true
        }).success).toBe(true)
        expect(GitOperationSchema.safeParse({
            kind: 'delete-remote-branch',
            repository: '/workspace/repository',
            remote: 'origin',
            name: 'feature/workspace-controls'
        }).success).toBe(true)
    })

    it('rejects option-like Git remote names', () => {
        const operations = [
            { kind: 'push', repository: '/workspace/repository', remote: '--all' },
            { kind: 'fetch', repository: '/workspace/repository', remote: '-n' },
            { kind: 'set-remote', repository: '/workspace/repository', remote: '--add', url: 'https://example.com/repository.git' },
            { kind: 'delete-remote-branch', repository: '/workspace/repository', remote: '--mirror', name: 'feature/test' },
            { kind: 'push', repository: '/workspace/repository', remote: '.' },
            { kind: 'fetch', repository: '/workspace/repository', remote: '..' }
        ]
        for (const operation of operations) {
            expect(GitOperationSchema.safeParse(operation).success).toBe(false)
        }
    })

    it('rejects invalid Git branch ref names', () => {
        for (const name of ['feature//workspace', '.hidden/name', 'feature/name.lock', 'feature/@{bad', '@']) {
            expect(GitOperationSchema.safeParse({
                kind: 'switch-branch',
                repository: '/workspace/repository',
                name
            }).success).toBe(false)
        }
    })

    it('rejects create-file content above the text file limit', () => {
        expect(FileOperationSchema.safeParse({
            kind: 'create-file',
            path: '/workspace/large.txt',
            content: 'x'.repeat(2 * 1024 * 1024 + 1)
        }).success).toBe(false)
    })

    it('applies the text file limit to UTF-8 bytes', () => {
        const content = '界'.repeat(Math.floor(MAX_HOST_FILE_TEXT_BYTES / 3) + 1)
        expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(MAX_HOST_FILE_TEXT_BYTES)
        expect(FileOperationSchema.safeParse({
            kind: 'create-file',
            path: '/workspace/large.txt',
            content
        }).success).toBe(false)
        expect(HostFileWriteRequestSchema.safeParse({
            path: '/workspace/large.txt',
            content
        }).success).toBe(false)
    })

    it('accepts bounded uploads to one directory and rejects path-like file names', () => {
        expect(HostFileUploadRequestSchema.safeParse({
            directory: '/workspace',
            name: 'notes.txt',
            contentBase64: 'aGVsbG8=',
            conflict: 'new-copy'
        }).success).toBe(true)
        expect(HostFileUploadRequestSchema.safeParse({
            directory: '/workspace',
            name: 'empty.txt',
            contentBase64: ''
        }).success).toBe(true)
        expect(HostFileUploadRequestSchema.safeParse({
            directory: '/workspace',
            name: '../outside.txt',
            contentBase64: 'aGVsbG8='
        }).success).toBe(false)
    })
})
