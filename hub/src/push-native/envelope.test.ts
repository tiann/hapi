import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
    PUSH_ENVELOPE_AAD,
    PUSH_KEY_LENGTH,
    PUSH_NONCE_LENGTH,
    canonicalJson,
    decryptEnvelope,
    encryptEnvelope
} from './envelope'

/**
 * PUSH SPEC v1 golden vector - hardcoded here (normative) and mirrored in
 * shared/fixtures/push/envelope-v1.json for the iOS implementation. If this
 * test fails, the wire format changed and every shipped app breaks.
 */
const VECTOR_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const VECTOR_NONCE = Buffer.from(Array.from({ length: 12 }, (_, i) => i))
const VECTOR_PLAINTEXT = '{"body":"Ready for input","contractVersion":"1","sessionId":"s1","title":"HAPI","type":"ready"}'
const VECTOR_ENVELOPE = 'AAECAwQFBgcICQoLPCC0dKGc4CGvE/Lq1ZBYC+ykp12eCyoIGkvH5nIHdMBgc9qqyrNh8RvKXdeqtgoUzCoF/im/zLR28wgjOpDEzNweshOnvUNDJnbiL7/GLMQa/rASE0FpSo+Y/6gB0sShxRvIOvgJGpKK+MjRlFlu'

describe('push envelope v1', () => {
    it('reproduces the normative test vector exactly', () => {
        expect(encryptEnvelope(VECTOR_KEY, VECTOR_PLAINTEXT, VECTOR_NONCE)).toBe(VECTOR_ENVELOPE)
    })

    it('shared fixture file matches the hardcoded vector (iOS consumes the file)', () => {
        const fixturePath = join(import.meta.dir, '../../../shared/fixtures/push/envelope-v1.json')
        const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
            key_hex: string
            nonce_hex: string
            aad: string
            plaintext: string
            envelope_b64: string
        }
        expect(Buffer.from(fixture.key_hex, 'hex')).toEqual(VECTOR_KEY)
        expect(Buffer.from(fixture.nonce_hex, 'hex')).toEqual(VECTOR_NONCE)
        expect(fixture.aad).toBe(PUSH_ENVELOPE_AAD)
        expect(fixture.plaintext).toBe(VECTOR_PLAINTEXT)
        expect(fixture.envelope_b64).toBe(VECTOR_ENVELOPE)
        expect(encryptEnvelope(
            Buffer.from(fixture.key_hex, 'hex'),
            fixture.plaintext,
            Buffer.from(fixture.nonce_hex, 'hex')
        )).toBe(fixture.envelope_b64)
    })

    it('vector plaintext is already in canonical form', () => {
        expect(canonicalJson(JSON.parse(VECTOR_PLAINTEXT))).toBe(VECTOR_PLAINTEXT)
    })

    it('decrypts the vector envelope back to the plaintext', () => {
        expect(decryptEnvelope(VECTOR_KEY, VECTOR_ENVELOPE)).toBe(VECTOR_PLAINTEXT)
    })

    it('roundtrips with a random key and random nonce', () => {
        const key = randomBytes(PUSH_KEY_LENGTH)
        const plaintext = canonicalJson({
            type: 'permission-request',
            sessionId: 'sess-9',
            title: 'Permission Request',
            body: 'Claude Bash: rm -rf /tmp/x',
            contractVersion: '1',
            requestId: 'req-1'
        })
        const envelope = encryptEnvelope(key, plaintext)
        expect(decryptEnvelope(key, envelope)).toBe(plaintext)
        // Fresh nonce per call: two envelopes of the same message differ.
        expect(encryptEnvelope(key, plaintext)).not.toBe(envelope)
    })

    it('rejects a tampered envelope (flipped ciphertext bit)', () => {
        const raw = Buffer.from(VECTOR_ENVELOPE, 'base64')
        raw[PUSH_NONCE_LENGTH] ^= 0x01
        expect(() => decryptEnvelope(VECTOR_KEY, raw.toString('base64'))).toThrow()
    })

    it('rejects a tampered auth tag', () => {
        const raw = Buffer.from(VECTOR_ENVELOPE, 'base64')
        raw[raw.length - 1] ^= 0x80
        expect(() => decryptEnvelope(VECTOR_KEY, raw.toString('base64'))).toThrow()
    })

    it('rejects decryption under the wrong key', () => {
        const wrongKey = Buffer.from(VECTOR_KEY)
        wrongKey[0] ^= 0xff
        expect(() => decryptEnvelope(wrongKey, VECTOR_ENVELOPE)).toThrow()
    })

    it('rejects truncated envelopes', () => {
        const raw = Buffer.from(VECTOR_ENVELOPE, 'base64').subarray(0, PUSH_NONCE_LENGTH + 15)
        expect(() => decryptEnvelope(VECTOR_KEY, raw.toString('base64'))).toThrow('push envelope too short')
    })

    it('rejects keys and nonces of the wrong size', () => {
        expect(() => encryptEnvelope(randomBytes(16), 'x')).toThrow('32 bytes')
        expect(() => encryptEnvelope(randomBytes(32), 'x', randomBytes(16))).toThrow('12 bytes')
        expect(() => decryptEnvelope(randomBytes(16), VECTOR_ENVELOPE)).toThrow('32 bytes')
    })
})

describe('canonicalJson', () => {
    it('sorts keys recursively', () => {
        expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } }))
            .toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}')
    })

    it('drops undefined properties and keeps null', () => {
        expect(canonicalJson({ b: undefined, a: null, c: 'x' })).toBe('{"a":null,"c":"x"}')
    })

    it('preserves array order (only object keys are sorted)', () => {
        expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    })

    it('is stable for scalars and unicode strings', () => {
        expect(canonicalJson('中文')).toBe('"中文"')
        expect(canonicalJson(42)).toBe('42')
        expect(canonicalJson(true)).toBe('true')
    })
})
