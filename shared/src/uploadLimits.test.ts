import { describe, expect, it } from 'bun:test'
import {
    DEFAULT_MAX_UPLOAD_BYTES,
    InitChunkedUploadRequestSchema,
    MAX_CONFIGURABLE_UPLOAD_BYTES,
    resolveMaxUploadBytes
} from './apiTypes'

describe('resolveMaxUploadBytes', () => {
    it('returns the 512 MiB default when unset or blank', () => {
        expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES)
        expect(resolveMaxUploadBytes('')).toBe(DEFAULT_MAX_UPLOAD_BYTES)
        expect(resolveMaxUploadBytes('   ')).toBe(DEFAULT_MAX_UPLOAD_BYTES)
    })

    it('parses valid positive integer byte limits', () => {
        expect(resolveMaxUploadBytes('104857600')).toBe(104_857_600)
        expect(resolveMaxUploadBytes(' 2048 ')).toBe(2048)
    })

    it('clamps limits above MAX_CONFIGURABLE_UPLOAD_BYTES', () => {
        expect(resolveMaxUploadBytes('99999999999999')).toBe(MAX_CONFIGURABLE_UPLOAD_BYTES)
    })

    it('falls back to the default for invalid, zero, negative, or non-integer values', () => {
        for (const value of ['0', '-5', 'abc', '100mb', '1.5']) {
            expect(resolveMaxUploadBytes(value)).toBe(DEFAULT_MAX_UPLOAD_BYTES)
        }
    })
})

describe('InitChunkedUploadRequestSchema', () => {
    it('accepts zero-byte files and valid filenames up to 255 characters', () => {
        expect(InitChunkedUploadRequestSchema.safeParse({
            filename: 'empty.txt',
            size: 0,
            mimeType: 'text/plain'
        }).success).toBe(true)

        expect(InitChunkedUploadRequestSchema.safeParse({
            filename: 'a'.repeat(255),
            size: 1024,
            mimeType: 'application/octet-stream'
        }).success).toBe(true)
    })

    it('rejects negative sizes and filenames exceeding 255 characters', () => {
        expect(InitChunkedUploadRequestSchema.safeParse({
            filename: 'bad.bin',
            size: -1,
            mimeType: 'application/octet-stream'
        }).success).toBe(false)

        expect(InitChunkedUploadRequestSchema.safeParse({
            filename: 'a'.repeat(256),
            size: 10,
            mimeType: 'application/octet-stream'
        }).success).toBe(false)
    })
})
