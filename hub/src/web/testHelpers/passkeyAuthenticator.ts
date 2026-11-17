import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
await import('reflect-metadata')
const { isoCBOR } = await import('@simplewebauthn/server/helpers')
const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

/** Minimal software authenticator: ES256, `none` attestation, UP+UV set. */
export class SoftAuthenticator {
    readonly credentialId = randomBytes(16)
    private readonly privateKey: KeyObject
    private readonly publicJwk: { x: string; y: string }
    private counter = 0
    userHandle: string | null = null

    constructor(private readonly rpId: string, public origin: string) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
        this.privateKey = privateKey
        this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    }

    virtualCredential() {
        return {
            credentialId: this.credentialId.toString('base64'), rpId: this.rpId,
            privateKey: this.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
            userHandle: this.userHandle ? Buffer.from(this.userHandle, 'base64url').toString('base64') : undefined,
            signCount: this.counter, isResidentCredential: true
        }
    }

    private clientData(type: string, challenge: string): Buffer {
        return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
    }

    create(options: { challenge: string; user: { id: string } }) {
        this.userHandle = options.user.id
        const cose = new Map<number, number | Uint8Array>([
            [1, 2], [3, -7], [-1, 1],
            [-2, new Uint8Array(Buffer.from(this.publicJwk.x, 'base64url'))],
            [-3, new Uint8Array(Buffer.from(this.publicJwk.y, 'base64url'))]
        ])
        const idLength = Buffer.alloc(2)
        idLength.writeUInt16BE(this.credentialId.length)
        const authData = Buffer.concat([
            sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
            idLength, this.credentialId, Buffer.from(isoCBOR.encode(cose))
        ])
        const attestationObject = isoCBOR.encode(new Map<string, unknown>([
            ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]
        ]) as never)
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge)),
                attestationObject: b64url(attestationObject),
                transports: ['internal']
            },
            clientExtensionResults: {},
            authenticatorAttachment: null
        }
    }

    get(options: { challenge: string }) {
        this.counter += 1
        const counter = Buffer.alloc(4)
        counter.writeUInt32BE(this.counter)
        const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), counter])
        const clientData = this.clientData('webauthn.get', options.challenge)
        const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey)
        return {
            id: b64url(this.credentialId),
            rawId: b64url(this.credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(clientData),
                authenticatorData: b64url(authData),
                signature: b64url(signature),
                userHandle: this.userHandle ?? undefined
            },
            clientExtensionResults: {}
        }
    }
}
