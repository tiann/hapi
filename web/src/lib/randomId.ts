type CryptoWithOptionalRandomUUID = Crypto & { randomUUID?: () => string }

function getRuntimeCrypto(): CryptoWithOptionalRandomUUID | undefined {
    return (globalThis as typeof globalThis & { crypto?: CryptoWithOptionalRandomUUID }).crypto
}

function randomBase36Segment(): string {
    return Math.random().toString(36).slice(2, 10)
}

export function randomId(): string {
    const runtimeCrypto = getRuntimeCrypto()

    if (typeof runtimeCrypto?.randomUUID === 'function') {
        return runtimeCrypto.randomUUID()
    }

    if (typeof runtimeCrypto?.getRandomValues === 'function') {
        try {
            const bytes = new Uint32Array(3)
            runtimeCrypto.getRandomValues(bytes)
            return `${Date.now().toString(36)}-${Array.from(bytes, (value) => value.toString(36)).join('-')}`
        } catch {
            // Fall through to Math.random. These IDs are local UI handles, not secrets.
        }
    }

    return `${Date.now().toString(36)}-${randomBase36Segment()}-${randomBase36Segment()}`
}
