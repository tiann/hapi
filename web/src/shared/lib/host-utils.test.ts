import { describe, expect, it } from 'vitest'
import { getHostDisplayName, getHostColorKey, getShortMachineId } from './host-utils'

describe('getShortMachineId', () => {
    it('returns first 8 characters of machineId', () => {
        expect(getShortMachineId('abcdef123456')).toBe('abcdef12')
    })

    it('returns null for undefined', () => {
        expect(getShortMachineId(undefined)).toBe(null)
    })

    it('returns null for empty string', () => {
        expect(getShortMachineId('')).toBe(null)
    })

    it('returns null for whitespace-only string', () => {
        expect(getShortMachineId('   ')).toBe(null)
    })
})

describe('getHostDisplayName', () => {
    it('returns full format when all fields present', () => {
        const result = getHostDisplayName({
            host: 'jlovec',
            platform: 'linux',
            machineId: '54080f81abcd'
        })
        expect(result).toBe('jlovec(linux:54080f81)')
    })

    it('returns host(platform) when machineId missing', () => {
        const result = getHostDisplayName({
            host: 'jlovec',
            platform: 'linux'
        })
        expect(result).toBe('jlovec(linux)')
    })

    it('returns host(machineId) when platform missing', () => {
        const result = getHostDisplayName({
            host: 'jlovec',
            machineId: '54080f81abcd'
        })
        expect(result).toBe('jlovec(54080f81)')
    })

    it('returns host only when platform and machineId missing', () => {
        const result = getHostDisplayName({
            host: 'jlovec'
        })
        expect(result).toBe('jlovec')
    })

    it('prefers displayName over host', () => {
        const result = getHostDisplayName({
            displayName: 'My Laptop',
            host: 'jlovec',
            platform: 'darwin',
            machineId: '12345678'
        })
        expect(result).toBe('My Laptop(darwin:12345678)')
    })

    it('falls back to short machineId when no host or displayName', () => {
        const result = getHostDisplayName({
            machineId: 'abcdef123456'
        })
        expect(result).toBe('abcdef12')
    })

    it('falls back to short sessionId when no other fields', () => {
        const result = getHostDisplayName({
            sessionId: 'session-id-12345'
        })
        expect(result).toBe('session-')
    })

    it('returns null when all fields missing', () => {
        const result = getHostDisplayName({})
        expect(result).toBe(null)
    })

    it('trims whitespace from all fields', () => {
        const result = getHostDisplayName({
            host: '  jlovec  ',
            platform: '  linux  ',
            machineId: '  54080f81  '
        })
        expect(result).toBe('jlovec(linux:54080f81)')
    })
})

describe('getHostColorKey', () => {
    it('prefers host for color stability', () => {
        const result = getHostColorKey({
            host: 'jlovec',
            displayName: 'My Laptop',
            machineId: '12345678'
        })
        expect(result).toBe('jlovec')
    })

    it('falls back to displayName when host missing', () => {
        const result = getHostColorKey({
            displayName: 'My Laptop',
            machineId: '12345678'
        })
        expect(result).toBe('My Laptop')
    })

    it('falls back to machineId when host and displayName missing', () => {
        const result = getHostColorKey({
            machineId: '12345678'
        })
        expect(result).toBe('12345678')
    })

    it('falls back to sessionId when all else missing', () => {
        const result = getHostColorKey({
            sessionId: 'session-123'
        })
        expect(result).toBe('session-123')
    })

    it('returns null when all fields missing', () => {
        const result = getHostColorKey({})
        expect(result).toBe(null)
    })
})
