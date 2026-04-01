import { describe, expect, it } from 'vitest'
import { hashRunnerCliApiToken, isRunnerStateCompatibleWithIdentity } from './runnerIdentity'

describe('runnerIdentity', () => {
    it('matches when api url, machine id, token hash all same', () => {
        const tokenHash = hashRunnerCliApiToken('secret-token')

        expect(isRunnerStateCompatibleWithIdentity(
            {
                startedWithApiUrl: 'http://example.com',
                startedWithMachineId: 'machine-123',
                startedWithCliApiTokenHash: tokenHash
            },
            {
                apiUrl: 'http://example.com',
                machineId: 'machine-123',
                cliApiTokenHash: tokenHash
            }
        )).toBe(true)
    })

    it('rejects reused runner when api url changed', () => {
        expect(isRunnerStateCompatibleWithIdentity(
            {
                startedWithApiUrl: 'http://old-hub',
                startedWithMachineId: 'machine-123',
                startedWithCliApiTokenHash: hashRunnerCliApiToken('secret-token')
            },
            {
                apiUrl: 'http://new-hub',
                machineId: 'machine-123',
                cliApiTokenHash: hashRunnerCliApiToken('secret-token')
            }
        )).toBe(false)
    })

    it('rejects reused runner when token changed', () => {
        expect(isRunnerStateCompatibleWithIdentity(
            {
                startedWithApiUrl: 'http://example.com',
                startedWithMachineId: 'machine-123',
                startedWithCliApiTokenHash: hashRunnerCliApiToken('old-token')
            },
            {
                apiUrl: 'http://example.com',
                machineId: 'machine-123',
                cliApiTokenHash: hashRunnerCliApiToken('new-token')
            }
        )).toBe(false)
    })

    it('rejects reused runner when current machine id is missing', () => {
        expect(isRunnerStateCompatibleWithIdentity(
            {
                startedWithApiUrl: 'http://example.com',
                startedWithMachineId: 'machine-123',
                startedWithCliApiTokenHash: hashRunnerCliApiToken('secret-token')
            },
            {
                apiUrl: 'http://example.com',
                cliApiTokenHash: hashRunnerCliApiToken('secret-token')
            }
        )).toBe(false)
    })

    it('rejects reused runner when current token hash is missing', () => {
        expect(isRunnerStateCompatibleWithIdentity(
            {
                startedWithApiUrl: 'http://example.com',
                startedWithMachineId: 'machine-123',
                startedWithCliApiTokenHash: hashRunnerCliApiToken('secret-token')
            },
            {
                apiUrl: 'http://example.com',
                machineId: 'machine-123'
            }
        )).toBe(false)
    })

    it('rejects old runner state missing connection identity', () => {
        expect(isRunnerStateCompatibleWithIdentity(
            {},
            {
                apiUrl: 'http://example.com',
                machineId: 'machine-123',
                cliApiTokenHash: hashRunnerCliApiToken('secret-token')
            }
        )).toBe(false)
    })
})
