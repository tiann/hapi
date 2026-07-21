import { describe, expect, it } from 'bun:test'
import { detectUpgradeChannel, machineTrailsUpgradeOffer, type HubUpgradeOffer } from './upgradeChannel'

describe('detectUpgradeChannel', () => {
    it('honors explicit override', () => {
        expect(detectUpgradeChannel({
            envChannel: 'npm',
            isCompiled: false,
            execPath: '/home/me/coding/hapi/driver/cli/src/index.ts',
            projectPath: '/home/me/coding/hapi/driver/cli',
            monorepoRootExists: true,
        })).toBe('npm')

        expect(detectUpgradeChannel({
            envChannel: 'off',
            isCompiled: true,
            execPath: '/usr/local/bin/hapi',
            projectPath: '/tmp',
            monorepoRootExists: false,
        })).toBe('off')
    })

    it('classifies npm global / node_modules installs as npm', () => {
        expect(detectUpgradeChannel({
            isCompiled: false,
            execPath: '/home/me/.bun/install/global/node_modules/@twsxtd/hapi/bin/hapi.cjs',
            projectPath: '/home/me/.bun/install/global/node_modules/@twsxtd/hapi',
            monorepoRootExists: false,
        })).toBe('npm')

        expect(detectUpgradeChannel({
            isCompiled: false,
            execPath: '/usr/lib/node_modules/@twsxtd/hapi/bin/hapi.cjs',
            projectPath: '/usr/lib/node_modules/@twsxtd/hapi',
            monorepoRootExists: false,
        })).toBe('npm')
    })

    it('classifies monorepo / soup source trees as hub-artifact', () => {
        expect(detectUpgradeChannel({
            isCompiled: false,
            execPath: '/home/me/.bun/bin/bun',
            projectPath: '/home/me/coding/hapi/driver/cli',
            monorepoRootExists: true,
        })).toBe('hub-artifact')
    })

    it('classifies compiled binaries outside node_modules as hub-artifact when monorepo is available', () => {
        expect(detectUpgradeChannel({
            isCompiled: true,
            execPath: '/home/me/.hapi/runtime/0.23.0/hapi',
            projectPath: '/home/me/coding/hapi/driver/cli',
            monorepoRootExists: true,
        })).toBe('hub-artifact')
    })

    it('falls back to npm for compiled binaries without a monorepo root', () => {
        expect(detectUpgradeChannel({
            isCompiled: true,
            execPath: '/usr/local/bin/hapi',
            projectPath: '/tmp',
            monorepoRootExists: false,
        })).toBe('npm')
    })
})

describe('machineTrailsUpgradeOffer', () => {
    const offer: HubUpgradeOffer = {
        channel: 'npm',
        targetVersion: '0.24.0',
        targetCapabilities: ['cursor-chat-store-status', 'runner-self-upgrade'],
        npmPackage: '@twsxtd/hapi',
    }

    it('trails on pure semver drift even with all target capabilities', () => {
        expect(machineTrailsUpgradeOffer(offer, '0.23.1', ['cursor-chat-store-status', 'runner-self-upgrade'])).toBe(true)
    })

    it('trails on a missing target capability even at the target version', () => {
        expect(machineTrailsUpgradeOffer(offer, '0.24.0', ['cursor-chat-store-status'])).toBe(true)
    })

    it('does not trail when version matches and all target capabilities present', () => {
        expect(machineTrailsUpgradeOffer(offer, '0.24.0', ['cursor-chat-store-status', 'runner-self-upgrade'])).toBe(false)
    })

    it('never chases the 0.0.0 fallback target', () => {
        const unknown: HubUpgradeOffer = { ...offer, targetVersion: '0.0.0' }
        expect(machineTrailsUpgradeOffer(unknown, '0.23.1', [])).toBe(false)
    })

    it('never fires when channel is off', () => {
        const off: HubUpgradeOffer = { ...offer, channel: 'off' }
        expect(machineTrailsUpgradeOffer(off, '0.1.0', [])).toBe(false)
    })

    it('falls back to capability check when version is unknown', () => {
        expect(machineTrailsUpgradeOffer(offer, null, ['cursor-chat-store-status', 'runner-self-upgrade'])).toBe(false)
        expect(machineTrailsUpgradeOffer(offer, undefined, ['cursor-chat-store-status'])).toBe(true)
    })
})
