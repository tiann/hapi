import { createHmac } from 'node:crypto'
import { constantTimeEquals } from './crypto'
import { configuration } from '../configuration'

export const DEFAULT_NAMESPACE = 'default'

export type AccessTokenCredentials = {
    defaultToken: string
    namespaceTokens: Readonly<Record<string, string>>
}

export type AccessTokenNamespaceResolver = (rawToken: string) => string | null

export type AccessTokenBinding = {
    namespace: string
    credentialFingerprint: string | null | undefined
}

export type AccessTokenBindingValidator = (binding: AccessTokenBinding) => boolean

const BINDING_FINGERPRINT_DOMAIN = 'hapi:access-token-binding:v1\0'

/**
 * Resolves an opaque credential to a namespace chosen by server configuration.
 * The caller never supplies a namespace, and ambiguous credentials fail closed.
 */
export function resolveAccessTokenNamespace(
    rawToken: string,
    credentials: AccessTokenCredentials,
): string | null {
    if (typeof rawToken !== 'string') {
        return null
    }

    const token = rawToken.trim()
    if (!token) {
        return null
    }

    const candidates: Array<[string, string]> = [
        [DEFAULT_NAMESPACE, credentials.defaultToken],
        ...Object.entries(credentials.namespaceTokens).sort(([left], [right]) => left.localeCompare(right)),
    ]

    let matchedNamespace: string | null = null
    let matchCount = 0
    for (const [namespace, credential] of candidates) {
        if (constantTimeEquals(token, credential)) {
            matchedNamespace = namespace
            matchCount += 1
        }
    }

    return matchCount === 1 ? matchedNamespace : null
}

export function resolveConfiguredAccessTokenNamespace(rawToken: string): string | null {
    return resolveAccessTokenNamespace(rawToken, {
        defaultToken: configuration.cliApiToken,
        namespaceTokens: configuration.namespaceTokens,
    })
}

export function createAccessTokenBindingFingerprint(
    rawToken: string,
    secret: Uint8Array,
): string | null {
    const token = typeof rawToken === 'string' ? rawToken.trim() : ''
    if (!token) {
        return null
    }

    return createHmac('sha256', secret)
        .update(BINDING_FINGERPRINT_DOMAIN)
        .update(token)
        .digest('hex')
}

function getCredentialForNamespace(
    namespace: string,
    credentials: AccessTokenCredentials,
): string | null {
    const credential = namespace === DEFAULT_NAMESPACE
        ? credentials.defaultToken
        : credentials.namespaceTokens[namespace]
    if (typeof credential !== 'string' || !credential.trim()) {
        return null
    }
    return resolveAccessTokenNamespace(credential, credentials) === namespace ? credential : null
}

export function isAccessTokenBindingCurrent(
    binding: AccessTokenBinding,
    secret: Uint8Array,
    credentials: AccessTokenCredentials,
): boolean {
    if (typeof binding.credentialFingerprint !== 'string') {
        return false
    }
    const credential = getCredentialForNamespace(binding.namespace, credentials)
    if (!credential) {
        return false
    }
    const expected = createAccessTokenBindingFingerprint(credential, secret)
    return constantTimeEquals(binding.credentialFingerprint, expected)
}

export function createConfiguredAccessTokenBindingValidator(
    secret: Uint8Array,
): AccessTokenBindingValidator {
    return (binding) => isAccessTokenBindingCurrent(binding, secret, {
        defaultToken: configuration.cliApiToken,
        namespaceTokens: configuration.namespaceTokens,
    })
}
