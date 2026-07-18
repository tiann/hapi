import { describe, expect, it } from 'bun:test'
import { detectUpgradeChannel } from './upgradeChannel'

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
