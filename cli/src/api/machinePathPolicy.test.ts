import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESOLVE_TIMEOUT_MS, MachinePathPolicy } from './machinePathPolicy'

// Redirectable realpath for stall tests; null delegates to the real one.
const realpathImpl = vi.hoisted(() => ({
    current: null as null | ((path: string) => Promise<string>),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        realpath: (path: string) =>
            realpathImpl.current ? realpathImpl.current(path) : actual.realpath(path),
    }
})

afterEach(() => {
    realpathImpl.current = null
})

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
        expect(await policy.allowsBrowse(first)).toBe(true)
        expect(await policy.allowsBrowse(collision)).toBe(false)
        expect(await policy.allowsBrowse(join(first, '..project'))).toBe(true)
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
        expect(await policy.allowsBrowse(escape)).toBe(false)
        expect(await policy.resolveForCheck(join(escape, 'missing'))).toBe(
            join(await realpath(outside), 'missing')
        )
    })

    it('allows both browsing and spawning outside home without explicit roots', async () => {
        const base = await mkdtemp(join(tmpdir(), 'hapi-path-policy-'))
        const home = join(base, 'home')
        const outside = join(base, 'outside')
        await Promise.all([mkdir(home), mkdir(outside)])
        const policy = new MachinePathPolicy()

        expect(await policy.allowsSpawn(outside)).toBe(true)
        expect(await policy.allowsBrowse(join(home, 'missing'))).toBe(true)
        expect(await policy.allowsBrowse(outside)).toBe(true)
    })

    it('falls back to the unresolved path when symlink resolution stalls', async () => {
        const base = await mkdtemp(join(tmpdir(), 'hapi-path-policy-'))
        const root = join(base, 'root')
        await mkdir(root)
        // A stalled filesystem: realpath never settles (disk sleep, idle
        // throttling). The watchdog must answer instead of hanging the RPC.
        realpathImpl.current = () => new Promise<string>(() => {})
        const policy = new MachinePathPolicy({ workspaceRoots: [root], resolveTimeoutMs: 10 })

        const inside = join(root, 'child')
        expect(await policy.resolveForCheck(inside)).toBe(inside)
        expect(await policy.allowsSpawn(inside)).toBe(true)
        expect(await policy.allowsBrowse(inside)).toBe(true)
        // Lexical containment still denies clearly-outside paths.
        expect(await policy.allowsSpawn(join(base, 'elsewhere'))).toBe(false)
    })

    it('exposes a sane default deadline', () => {
        expect(DEFAULT_RESOLVE_TIMEOUT_MS).toBeGreaterThan(0)
    })
})
