import { describe, expect, it } from 'vitest'
import { BoundedFileReadError } from './generatedImages'
import { classifyFileReadError, FileReadFailureError } from './fileReadFailures'

function nodeError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code })
}

describe('classifyFileReadError', () => {
    it('preserves classification and size from file read errors', () => {
        expect(classifyFileReadError(new FileReadFailureError('outside-workspace', 'blocked'))).toEqual({
            reason: 'outside-workspace',
        })
        expect(classifyFileReadError(new BoundedFileReadError('too-large', 'too large', 42))).toEqual({
            reason: 'too-large',
            size: 42,
        })
    })

    it.each([
        ['ENOENT', 'not-found'],
        ['ENOTDIR', 'not-found'],
        ['EACCES', 'access-denied'],
        ['EPERM', 'access-denied'],
        ['EISDIR', 'not-regular-file'],
        ['EIO', 'read-failed'],
    ] as const)('maps %s to %s', (code, reason) => {
        expect(classifyFileReadError(nodeError(code))).toEqual({ reason })
    })

    it('falls back to read-failed for unknown values', () => {
        expect(classifyFileReadError(new Error('unknown'))).toEqual({ reason: 'read-failed' })
        expect(classifyFileReadError(null)).toEqual({ reason: 'read-failed' })
    })
})