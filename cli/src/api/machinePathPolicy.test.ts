import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MachinePathPolicy } from './machinePathPolicy'

describe('MachinePathPolicy', () => {
    it('accepts paths inside any configured root and rejects prefix collisions', async () => {
        const base = await mkdtemp(join(tmpdir(), 'hapi-path-policy-'))
        const first = join(base, 'one')
        const second = join(base, 'two')
        const collision = join(base, 'one-other')
        await Promise.all([mkdir(first), mkdir(second), mkdir(collision)])
        const policy = new MachinePathPolicy({ workspaceRoots: [first, second] })

        expect(await policy.allowsSpawn(join(first, 'missing', 'child'))).toBe(true)
        expect(await policy.allowsSpawn(second)).toBe(true)
        expect(await policy.allowsSpawn(collision)).toBe(false)
    })

    it('resolves an existing symlink before checking a missing child', async () => {
        const base = await mkdtemp(join(tmpdir(), 'hapi-path-policy-'))
        const root = join(base, 'root')
        const outside = join(base, 'outside')
        await Promise.all([mkdir(root), mkdir(outside)])
        const escape = join(root, 'escape')
        await symlink(outside, escape, 'dir')
        const policy = new MachinePathPolicy({ workspaceRoots: [root] })

        expect(await policy.allowsSpawn(join(escape, 'missing'))).toBe(false)
        expect(await policy.resolveForCheck(join(escape, 'missing'))).toBe(
            join(await realpath(outside), 'missing')
        )
    })

    it('keeps manual spawn unrestricted but scopes browsing to home without roots', async () => {
        const base = await mkdtemp(join(tmpdir(), 'hapi-path-policy-'))
        const home = join(base, 'home')
        const outside = join(base, 'outside')
        await Promise.all([mkdir(home), mkdir(outside)])
        const policy = new MachinePathPolicy({ homeDirectory: home })

        expect(await policy.allowsSpawn(outside)).toBe(true)
        expect(await policy.allowsBrowse(join(home, 'missing'))).toBe(true)
        expect(await policy.allowsBrowse(outside)).toBe(false)
    })
})
