import { describe, expect, it } from 'vitest'
import { getNamespaceFromToken, isOwnerNamespace } from './namespace'

// JWTs below are unsigned test fixtures — only the `ns` claim in the payload
// segment matters, the header/signature segments are placeholders.
const DEFAULT_NS_TOKEN = 'header.eyJucyI6ImRlZmF1bHQifQ.sig'
const NAMED_NS_TOKEN = 'header.eyJucyI6IkNMSV9BUElfVE9LRU46dGVhbSJ9.sig'

describe('getNamespaceFromToken', () => {
    it('decodes the ns claim from a well-formed token', () => {
        expect(getNamespaceFromToken(DEFAULT_NS_TOKEN)).toBe('default')
        expect(getNamespaceFromToken(NAMED_NS_TOKEN)).toBe('CLI_API_TOKEN:team')
    })

    it('returns null for a malformed token instead of throwing', () => {
        expect(getNamespaceFromToken('not-a-jwt')).toBeNull()
        expect(getNamespaceFromToken('')).toBeNull()
    })

    it('returns null for a null token', () => {
        expect(getNamespaceFromToken(null)).toBeNull()
    })
})

describe('isOwnerNamespace', () => {
    it('is true only for the default namespace', () => {
        expect(isOwnerNamespace(DEFAULT_NS_TOKEN)).toBe(true)
        expect(isOwnerNamespace(NAMED_NS_TOKEN)).toBe(false)
        expect(isOwnerNamespace(null)).toBe(false)
    })
})
