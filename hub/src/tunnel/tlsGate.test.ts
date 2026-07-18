import { describe, expect, test } from 'bun:test'
import type { PeerCertificate } from 'node:tls'
import { hostMatchesCertificate } from './tlsGate'

function certificateWithCommonName(commonName: string | string[]): PeerCertificate {
    return {
        subject: { CN: commonName }
    } as PeerCertificate
}

describe('hostMatchesCertificate', () => {
    test('accepts a matching common name when Node reports multiple values', () => {
        expect(hostMatchesCertificate('hapi.example.com', certificateWithCommonName(['legacy.example.com', 'hapi.example.com']))).toBe(true)
    })

    test('rejects non-matching common names when Node reports multiple values', () => {
        expect(hostMatchesCertificate('hapi.example.com', certificateWithCommonName(['legacy.example.com', 'other.example.com']))).toBe(false)
    })

    test('preserves IP-address common-name matching for multiple values', () => {
        expect(hostMatchesCertificate('127.0.0.1', certificateWithCommonName(['10.0.0.1', '127.0.0.1']))).toBe(true)
    })
})
