import { describe, expect, it } from 'bun:test'
import {
    COMPRESS_MIN_CHARS,
    TRUNCATE_STRING_LIMIT,
    decodeMessageContent,
    encodeMessageContent,
    truncateOversizedMessageContent
} from './contentCodec'

const big = (n: number) => 'x'.repeat(n)

describe('encodeMessageContent / decodeMessageContent', () => {
    it('keeps small payloads as plaintext JSON strings', () => {
        const content = { role: 'user', content: { type: 'text', text: 'hi' } }
        const encoded = encodeMessageContent(content)
        expect(typeof encoded).toBe('string')
        expect(encoded.length).toBeLessThan(COMPRESS_MIN_CHARS)
        expect(decodeMessageContent(encoded as string)).toEqual(content)
    })

    it('compresses large payloads to a BLOB and round-trips them', () => {
        const content = { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', text: big(10_000) } } }
        const encoded = encodeMessageContent(content)
        expect(typeof encoded).not.toBe('string')
        expect((encoded as Buffer).length).toBeLessThan(10_000)
        expect(decodeMessageContent(encoded as Buffer)).toEqual(content)
    })

    it('decodes legacy plaintext rows and returns null for malformed input', () => {
        expect(decodeMessageContent('{"a":1}')).toEqual({ a: 1 })
        expect(decodeMessageContent('not json')).toBeNull()
        expect(decodeMessageContent(new Uint8Array([1, 2, 3]))).toBeNull()
        expect(decodeMessageContent(null)).toBeNull()
    })
})

describe('truncateOversizedMessageContent', () => {
    it('truncates oversized strings nested in agent content, keeping head and tail', () => {
        const payload = `HEAD${big(TRUNCATE_STRING_LIMIT * 3)}TAIL`
        const content = {
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call-result', output: { stdout: payload, exit: 0 } } }
        }
        const result = truncateOversizedMessageContent(content) as typeof content
        const stdout = result.content.data.output.stdout
        expect(stdout.length).toBeLessThanOrEqual(TRUNCATE_STRING_LIMIT)
        expect(stdout.startsWith('HEAD')).toBe(true)
        expect(stdout.endsWith('TAIL')).toBe(true)
        expect(stdout).toContain('[hapi: truncated')
        // Untouched siblings keep their values, original object is not mutated
        expect(result.content.data.output.exit).toBe(0)
        expect(content.content.data.output.stdout).toBe(payload)
    })

    it('is idempotent and identity-preserving when nothing is oversized', () => {
        const small = { role: 'agent', content: { type: 'codex', data: { text: 'ok' } } }
        expect(truncateOversizedMessageContent(small)).toBe(small)

        const bigContent = { role: 'agent', content: { type: 'output', data: big(TRUNCATE_STRING_LIMIT + 1) } }
        const once = truncateOversizedMessageContent(bigContent)
        expect(truncateOversizedMessageContent(once)).toBe(once)
    })

    it('never touches user messages, even oversized ones', () => {
        const content = { role: 'user', content: { type: 'text', text: big(TRUNCATE_STRING_LIMIT * 2) } }
        expect(truncateOversizedMessageContent(content)).toBe(content)
    })
})
