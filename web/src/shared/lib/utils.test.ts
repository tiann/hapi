import { describe, expect, it } from 'vitest'
import { cn, decodeBase64, encodeBase64 } from './utils'

describe('cn', () => {
    it('merges class names correctly', () => {
        expect(cn('foo', 'bar')).toBe('foo bar')
    })

    it('handles conditional classes', () => {
        expect(cn('foo', false && 'bar', 'baz')).toBe('foo baz')
    })

    it('merges tailwind classes without conflicts', () => {
        expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
    })

    it('handles empty input', () => {
        expect(cn()).toBe('')
    })

    it('handles undefined and null', () => {
        expect(cn('foo', undefined, null, 'bar')).toBe('foo bar')
    })
})

describe('decodeBase64', () => {
    it('decodes valid base64 string', () => {
        const encoded = btoa('hello world')
        const result = decodeBase64(encoded)
        expect(result.ok).toBe(true)
        expect(result.text).toBe('hello world')
    })

    it('decodes UTF-8 characters', () => {
        const text = '你好世界'
        const bytes = new TextEncoder().encode(text)
        const binaryString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
        const encoded = btoa(binaryString)
        const result = decodeBase64(encoded)
        expect(result.ok).toBe(true)
        expect(result.text).toBe(text)
    })

    it('handles invalid base64 string', () => {
        const result = decodeBase64('invalid!!!base64')
        expect(result.ok).toBe(false)
        expect(result.text).toBe('')
    })

    it('handles empty string', () => {
        const result = decodeBase64('')
        expect(result.ok).toBe(true)
        expect(result.text).toBe('')
    })
})

describe('encodeBase64', () => {
    it('encodes plain text to base64', () => {
        const encoded = encodeBase64('hello world')
        expect(atob(encoded)).toBe('hello world')
    })

    it('encodes UTF-8 characters', () => {
        const text = '你好世界'
        const encoded = encodeBase64(text)
        const bytes = new TextEncoder().encode(text)
        const binaryString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
        expect(encoded).toBe(btoa(binaryString))
    })

    it('handles empty string', () => {
        const encoded = encodeBase64('')
        expect(encoded).toBe('')
    })

    it('round-trip encoding and decoding', () => {
        const original = 'Test 测试 123 !@#'
        const encoded = encodeBase64(original)
        const decoded = decodeBase64(encoded)
        expect(decoded.ok).toBe(true)
        expect(decoded.text).toBe(original)
    })
})
