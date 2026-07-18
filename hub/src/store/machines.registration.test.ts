import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('getOrCreateMachine registration refresh', () => {
    it('updates stale version and capabilities on re-register', () => {
        const store = new Store(':memory:')
        const first = store.machines.getOrCreateMachine(
            'teemo',
            {
                host: 'Teemo',
                platform: 'linux',
                happyCliVersion: '0.20.2',
            },
            null,
            'default',
        )
        expect(first.metadataVersion).toBe(1)
        expect((first.metadata as { happyCliVersion?: string }).happyCliVersion).toBe('0.20.2')

        const second = store.machines.getOrCreateMachine(
            'teemo',
            {
                host: 'Teemo',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status', 'stop-runner'],
                displayName: undefined,
            },
            null,
            'default',
        )

        expect(second.metadataVersion).toBe(2)
        expect(second.metadata).toMatchObject({
            host: 'Teemo',
            happyCliVersion: '0.23.0',
            capabilities: ['cursor-chat-store-status', 'stop-runner'],
        })
    })

    it('preserves displayName when re-register omits it', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'proxmox',
            {
                host: 'proxmox',
                platform: 'linux',
                happyCliVersion: '0.18.4',
                displayName: 'Homelab',
            },
            null,
            'default',
        )

        const refreshed = store.machines.getOrCreateMachine(
            'proxmox',
            {
                host: 'proxmox',
                platform: 'linux',
                happyCliVersion: '0.23.0',
                capabilities: ['cursor-chat-store-status'],
            },
            null,
            'default',
        )

        expect(refreshed.metadata).toMatchObject({
            happyCliVersion: '0.23.0',
            displayName: 'Homelab',
            capabilities: ['cursor-chat-store-status'],
        })
    })

    it('is a no-op when registration metadata is unchanged', () => {
        const store = new Store(':memory:')
        const metadata = {
            host: 'oos-linux',
            platform: 'linux',
            happyCliVersion: '0.23.0',
            capabilities: ['cursor-chat-store-status'],
        }
        const first = store.machines.getOrCreateMachine('oos', metadata, null, 'default')
        const second = store.machines.getOrCreateMachine('oos', metadata, null, 'default')
        expect(second.metadataVersion).toBe(first.metadataVersion)
    })
})
