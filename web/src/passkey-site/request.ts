import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import {
    canonicalPasskeyHub, PASSKEY_MAX_REQUEST_LENGTH, PASSKEY_RP_ID,
    validatePasskeyChallenge, validatePasskeyUserHandle
} from '@hapi/protocol/passkey'

type Request =
    | { hub: string; operation: 'login'; options: PublicKeyCredentialRequestOptionsJSON }
    | { hub: string; operation: 'register'; options: PublicKeyCredentialCreationOptionsJSON }

/** This page accepts messages from untrusted, independently operated Hubs.
 * Never execute a ceremony without binding its challenge/account to that Hub. */
export async function parseCeremonyRequest(fragment: string): Promise<Request> {
    if (fragment.length > PASSKEY_MAX_REQUEST_LENGTH * 6) throw new Error('Request is too large')
    const json = decodeURIComponent(fragment.replace(/^#/, ''))
    if (json.length > PASSKEY_MAX_REQUEST_LENGTH) throw new Error('Request is too large')
    const value = JSON.parse(json) as Request
    if (!value || !value.options || (value.operation !== 'login' && value.operation !== 'register')) throw new Error('Invalid request')
    const hub = canonicalPasskeyHub(value.hub)
    if (hub !== value.hub) throw new Error('Invalid Hub address')
    validatePasskeyChallenge(value.options.challenge, hub, value.operation, 'browser')
    if (value.operation === 'login') {
        if (value.options.rpId !== PASSKEY_RP_ID || !value.options.allowCredentials?.length) throw new Error('Invalid relying party or credentials')
        return {
            hub, operation: 'login', options: {
                challenge: value.options.challenge, rpId: PASSKEY_RP_ID,
                allowCredentials: value.options.allowCredentials, userVerification: 'required', timeout: 120000
            }
        }
    }
    if (value.options.rp?.id !== PASSKEY_RP_ID) throw new Error('Invalid relying party')
    await validatePasskeyUserHandle(value.options.user.id, hub)
    if (!value.options.user.name.endsWith(`@${new URL(hub).host}`)) throw new Error('Invalid account name')
    return {
        hub, operation: 'register', options: {
            challenge: value.options.challenge,
            rp: { id: PASSKEY_RP_ID, name: 'HAPI' },
            user: { ...value.options.user, displayName: `HAPI · ${new URL(hub).host}` },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
            excludeCredentials: value.options.excludeCredentials,
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            attestation: 'none', timeout: 120000
        }
    }
}
