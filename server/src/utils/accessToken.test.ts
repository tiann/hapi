import { describe, expect, it } from 'bun:test'
import { DEFAULT_NAMESPACE, parseAccessToken } from './accessToken'

describe('parseAccessToken', () => {
    it('defaults namespace when missing', () => {
        const parsed = parseAccessToken('token')
        expect(parsed).toEqual({ baseToken: 'token', namespace: DEFAULT_NAMESPACE })
    })

    it('parses namespace suffix', () => {
        const parsed = parseAccessToken('token:alice')
        expect(parsed).toEqual({ baseToken: 'token', namespace: 'alice' })
    })

    it('rejects empty namespace', () => {
        expect(parseAccessToken('token:')).toBeNull()
    })

    it('rejects missing base token', () => {
        expect(parseAccessToken(':alice')).toBeNull()
    })

    it('rejects whitespace inside namespace', () => {
        expect(parseAccessToken('token: alice')).toBeNull()
    })
})
