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

    it('refreshes when incoming omits capabilities that were previously stored', () => {
        expect(machineRegistrationNeedsRefresh(
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
            },
            {
                host: 'teemo',
                platform: 'linux',
                happyCliVersion: '0.20.0',
                // downgraded runner omitted the field entirely
            },
        )).toBe(true)
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

    it('does not keep stale capabilities when incoming omits them', () => {
        expect(mergeMachineRegistrationMetadata(
            {
                host: 'proxmox',
                platform: 'linux',
                happyCliVersion: '0.23.3',
                capabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
                workspaceRoots: ['/home/heavygee/coding'],
            },
            {
                host: 'proxmox',
                platform: 'linux',
                happyCliVersion: '0.20.0',
            },
        )).toEqual({
            host: 'proxmox',
            platform: 'linux',
            happyCliVersion: '0.20.0',
            capabilities: [],
            workspaceRoots: ['/home/heavygee/coding'],
        })
    })
})
