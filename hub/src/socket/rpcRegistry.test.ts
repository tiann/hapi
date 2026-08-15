import { describe, expect, test } from 'bun:test'
import { RpcRegistry } from './rpcRegistry'

function socket(id: string): Parameters<RpcRegistry['register']>[0] {
    return { id } as Parameters<RpcRegistry['register']>[0]
}

describe('RpcRegistry', () => {
    test('drops a registration when its owner is no longer current', () => {
        const registry = new RpcRegistry()
        let current = true
        const owner = socket('old-socket')

        registry.register(owner, 'session-1:reasonix-config', () => current)
        expect(registry.getSocketIdForMethod('session-1:reasonix-config')).toBe('old-socket')

        current = false
        expect(registry.getSocketIdForMethod('session-1:reasonix-config')).toBeNull()
        expect(registry.getSocketIdForMethod('session-1:reasonix-config')).toBeNull()
    })

    test('keeps ordinary registrations usable without a validator', () => {
        const registry = new RpcRegistry()
        registry.register(socket('socket-1'), 'machine-1:ping')
        expect(registry.getSocketIdForMethod('machine-1:ping')).toBe('socket-1')
    })
})
