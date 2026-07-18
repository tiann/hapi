import { describe, expect, it } from 'vitest'
import {
    machineRegistrationNeedsRefresh,
    mergeMachineRegistrationMetadata,
    sortedCapabilities,
} from './machineRegistration'

describe('machineRegistration', () => {
    it('sorts capability ids for stable compare', () => {
        expect(sortedCapabilities(['b', 'a'])).toEqual(['a', 'b'])
        expect(sortedCapabilities(null)).toEqual([])
    })

    it('detects version and capability refresh', () => {
        expect(machineRegistrationNeedsRefresh(
            { host: 'teemo', platform: 'linux', happyCliVersion: '0.20.2' },
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status'],
            },
        )).toBe(true)

        expect(machineRegistrationNeedsRefresh(
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status'],
            },
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status'],
            },
        )).toBe(false)
    })

    it('preserves displayName when incoming omits it', () => {
        expect(mergeMachineRegistrationMetadata(
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.20.2',
                displayName: 'Teemo lab',
            },
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status'],
            },
        )).toEqual({
            host: 'teemo',
            platform: 'linux',
            happyCliVersion: '0.23.0',
            displayName: 'Teemo lab',
            capabilities: ['cursor-chat-store-status'],
        })
    })
})
