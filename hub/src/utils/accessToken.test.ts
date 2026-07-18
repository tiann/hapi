import { describe, expect, it } from 'bun:test'
import {
    createAccessTokenBindingFingerprint,
    DEFAULT_NAMESPACE,
    isAccessTokenBindingCurrent,
    resolveAccessTokenNamespace,
} from './accessToken'

const credentials = {
    defaultToken: 'default-token-credential',
    namespaceTokens: {
        alice: 'alice-token-credential',
        bob: 'bob-token-credential',
    },
}

describe('access token namespace resolution', () => {
    it('maps each independent credential to exactly one server-controlled namespace', () => {
        expect(resolveAccessTokenNamespace('default-token-credential', credentials)).toBe(DEFAULT_NAMESPACE)
        expect(resolveAccessTokenNamespace('alice-token-credential', credentials)).toBe('alice')
        expect(resolveAccessTokenNamespace('bob-token-credential', credentials)).toBe('bob')
    })

    it('rejects caller-selected namespace suffixes', () => {
        expect(resolveAccessTokenNamespace('default-token-credential:alice', credentials)).toBeNull()
        expect(resolveAccessTokenNamespace('alice-token-credential:bob', credentials)).toBeNull()
    })

    it('fails closed when a credential is ambiguously assigned twice', () => {
        expect(resolveAccessTokenNamespace('shared-token-credential', {
            defaultToken: 'default-token-credential',
            namespaceTokens: {
                alice: 'shared-token-credential',
                bob: 'shared-token-credential',
            },
        })).toBeNull()
    })
})

describe('persisted access token binding validation', () => {
    const secret = new TextEncoder().encode('binding-fingerprint-test-secret')

    it('accepts only the current credential fingerprint for the stored namespace', () => {
        const fingerprint = createAccessTokenBindingFingerprint('alice-token-credential', secret)

        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(fingerprint).not.toContain('alice-token-credential')
        expect(isAccessTokenBindingCurrent({
            namespace: 'alice',
            credentialFingerprint: fingerprint,
        }, secret, credentials)).toBe(true)
        expect(isAccessTokenBindingCurrent({
            namespace: 'bob',
            credentialFingerprint: fingerprint,
        }, secret, credentials)).toBe(false)
    })

    it('invalidates legacy, removed, or rotated namespace credentials', () => {
        const fingerprint = createAccessTokenBindingFingerprint('alice-token-credential', secret)

        expect(isAccessTokenBindingCurrent({
            namespace: 'alice',
            credentialFingerprint: null,
        }, secret, credentials)).toBe(false)
        expect(isAccessTokenBindingCurrent({
            namespace: 'alice',
            credentialFingerprint: fingerprint,
        }, secret, {
            ...credentials,
            namespaceTokens: { bob: 'bob-token-credential' },
        })).toBe(false)
        expect(isAccessTokenBindingCurrent({
            namespace: 'alice',
            credentialFingerprint: fingerprint,
        }, secret, {
            ...credentials,
            namespaceTokens: { ...credentials.namespaceTokens, alice: 'rotated-alice-credential' },
        })).toBe(false)
    })
})
