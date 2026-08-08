import { describe, expect, it } from 'bun:test'
import { Store } from './index'

/** Non-null runnerState marks a runner registration (not terminal bootstrap). */
const runnerAlive = { status: 'running' as const }

describe('getOrCreateMachine registration refresh', () => {
    it('updates stale version and capabilities on runner re-register', () => {
        const store = new Store(':memory:')
        const first = store.machines.getOrCreateMachine(
            'teemo',
            {
                host: 'Teemo',
                platform: 'linux',
                happyCliVersion: '0.20.2',
            },
            runnerAlive,
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
            runnerAlive,
            'default',
        )

        expect(second.metadataVersion).toBe(2)
        expect(second.metadata).toMatchObject({
            host: 'Teemo',
            happyCliVersion: '0.23.0',
            capabilities: ['cursor-chat-store-status', 'stop-runner'],
        })
    })

    it('preserves displayName when runner re-register omits it', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'proxmox',
            {
                host: 'proxmox',
                platform: 'linux',
                happyCliVersion: '0.18.4',
                displayName: 'Homelab',
            },
            runnerAlive,
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
            runnerAlive,
            'default',
        )

        expect(refreshed.metadata).toMatchObject({
            happyCliVersion: '0.23.0',
            displayName: 'Homelab',
            capabilities: ['cursor-chat-store-status'],
        })
    })

    it('is a no-op when runner registration metadata is unchanged', () => {
        const store = new Store(':memory:')
        const metadata = {
            host: 'oos-linux',
            platform: 'linux',
            happyCliVersion: '0.23.0',
            capabilities: ['cursor-chat-store-status'],
        }
        const first = store.machines.getOrCreateMachine('oos', metadata, runnerAlive, 'default')
        const second = store.machines.getOrCreateMachine('oos', metadata, runnerAlive, 'default')
        expect(second.metadataVersion).toBe(first.metadataVersion)
    })

    it('does not let terminal bootstrap mask a stale live runner', () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine(
            'shared-machine',
            {
                host: 'box',
                platform: 'linux',
                happyCliVersion: '0.20.2',
                capabilities: ['cursor-chat-store-status'],
            },
            runnerAlive,
            'default',
        )

        const afterTerminal = store.machines.getOrCreateMachine(
            'shared-machine',
            {
                host: 'box',
                platform: 'linux',
                happyCliVersion: '0.23.4',
                capabilities: ['cursor-chat-store-status', 'runner-self-upgrade', 'stop-runner'],
            },
            null,
            'default',
        )

        expect(afterTerminal.metadata).toMatchObject({
            happyCliVersion: '0.20.2',
            capabilities: ['cursor-chat-store-status'],
        })
        expect(afterTerminal.metadataVersion).toBe(1)
    })
})
