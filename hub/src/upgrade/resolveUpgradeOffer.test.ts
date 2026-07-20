import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findMonorepoRoot, resolveUpgradeOffer } from './resolveUpgradeOffer'

describe('resolveUpgradeOffer', () => {
    it('finds monorepo root from hub package path', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-mono-'))
        try {
            mkdirSync(join(root, 'cli'), { recursive: true })
            mkdirSync(join(root, 'shared'), { recursive: true })
            mkdirSync(join(root, 'hub'), { recursive: true })
            writeFileSync(join(root, 'cli', 'package.json'), JSON.stringify({ name: '@twsxtd/hapi', version: '9.9.9' }))
            writeFileSync(join(root, 'shared', 'package.json'), JSON.stringify({ name: '@hapi/protocol', version: '0.0.0' }))
            writeFileSync(join(root, 'hub', 'package.json'), JSON.stringify({ name: 'hapi-hub', version: '0.1.0' }))

            expect(findMonorepoRoot(join(root, 'hub'))).toBe(root)

            const offer = resolveUpgradeOffer({
                hubPackageRoot: join(root, 'hub'),
                execPath: '/home/me/.bun/bin/bun',
                envChannel: null,
            })
            expect(offer.channel).toBe('hub-artifact')
            expect(offer.targetVersion).toBe('9.9.9')
            expect(offer.artifact?.url).toContain('/cli/upgrade/cli-artifact')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('uses npm channel when override or npm exec path', () => {
        const offer = resolveUpgradeOffer({
            hubPackageRoot: '/tmp/not-a-mono/hub',
            monorepoRoot: null,
            execPath: '/home/me/.bun/install/global/node_modules/@twsxtd/hapi/bin/hapi.cjs',
            targetVersion: '0.23.0',
            envChannel: null,
        })
        expect(offer.channel).toBe('npm')
        expect(offer.npmPackage).toBe('@twsxtd/hapi')
        expect(offer.targetVersion).toBe('0.23.0')
    })

    it('honors HAPI_UPGRADE_CHANNEL=off', () => {
        const offer = resolveUpgradeOffer({
            hubPackageRoot: '/tmp/x/hub',
            monorepoRoot: '/tmp/x',
            execPath: '/usr/bin/bun',
            envChannel: 'off',
            targetVersion: '1.0.0',
        })
        expect(offer.channel).toBe('off')
    })

    it('reads npm package version from execPath when monorepo is absent', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-npm-pkg-'))
        try {
            writeFileSync(join(root, 'package.json'), JSON.stringify({
                name: '@twsxtd/hapi',
                version: '0.24.1',
            }))
            mkdirSync(join(root, 'bin'), { recursive: true })
            const execPath = join(root, 'bin', 'hapi.cjs')
            writeFileSync(execPath, '')

            const offer = resolveUpgradeOffer({
                hubPackageRoot: join(root, 'hub-missing'),
                monorepoRoot: null,
                execPath,
                envChannel: null,
            })
            expect(offer.channel).toBe('npm')
            expect(offer.targetVersion).toBe('0.24.1')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
