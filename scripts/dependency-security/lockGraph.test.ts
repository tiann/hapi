import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverSupportedLocks,
  parseBunLockGraph,
  parseNpmLockGraph,
  roleImpact,
} from './lockGraph'

describe('dependency lock graph', () => {
  it('accepts only root bun.lock plus the intentional npm tool lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-lock-discovery-'))
    await mkdir(join(root, 'tools/hapi-codex-sync'), { recursive: true })
    await writeFile(join(root, 'bun.lock'), '{}')
    await writeFile(join(root, 'tools/hapi-codex-sync/package-lock.json'), '{}')
    await expect(discoverSupportedLocks(root)).resolves.toEqual([
      { source: 'bun-workspaces', path: join(root, 'bun.lock') },
      { source: 'hapi-codex-sync', path: join(root, 'tools/hapi-codex-sync/package-lock.json') },
    ])
    await mkdir(join(root, 'website'))
    await writeFile(join(root, 'website/bun.lock'), '{}')
    await expect(discoverSupportedLocks(root)).rejects.toThrow(/unexpected lockfile.*website\/bun\.lock/i)
  })

  it('resolves nearest nested Bun and npm instances and preserves duplicate versions', async () => {
    const bunGraph = await parseBunLockGraph('scripts/dependency-security/fixtures/bun.lock.fixture')
    expect(bunGraph.nodes.filter((node) => node.name === 'duplicate').map((node) => node.version)).toEqual(['1.0.0', '2.0.0'])
    expect(bunGraph.edges).toContainEqual({ from: 'bun-workspaces:runtime-parent', to: 'bun-workspaces:runtime-parent/duplicate', kind: 'dependency' })
    expect(bunGraph.nodes.find((node) => node.name === 'dual-role')?.roles).toEqual(['runtime', 'build'])
    expect(bunGraph.edges).toContainEqual({ from: 'bun-workspaces:workspace:website', to: 'bun-workspaces:fixture-website/workspace-tool', kind: 'dev' })
    expect(bunGraph.nodes.find((node) => node.lockKey === 'fixture-website/workspace-tool')?.roles).toEqual(['build'])
    const npmGraph = await parseNpmLockGraph('scripts/dependency-security/fixtures/package-lock.fixture.json')
    expect(npmGraph.edges).toContainEqual({ from: 'hapi-codex-sync:node_modules/parent', to: 'hapi-codex-sync:node_modules/parent/node_modules/duplicate', kind: 'dependency' })
  })

  it('fails closed on an unresolved required edge or missing registry integrity', async () => {
    await expect(parseBunLockGraph('scripts/dependency-security/fixtures/bun-unresolved.lock.fixture')).rejects.toThrow(/unresolved required dependency/i)
    await expect(parseNpmLockGraph('scripts/dependency-security/fixtures/package-lock-missing-integrity.fixture.json')).rejects.toThrow(/missing registry integrity/i)
  })

  it('rejects missing and unsupported Bun config versions', async () => {
    const bunWithJsonc = Bun as typeof Bun & { JSONC: { parse(input: string): unknown } }
    const fixture = bunWithJsonc.JSONC.parse(
      await readFile('scripts/dependency-security/fixtures/bun.lock.fixture', 'utf8'),
    ) as Record<string, unknown>

    for (const [label, configVersion] of [['missing', undefined], ['unsupported', 2]] as const) {
      const root = await mkdtemp(join(tmpdir(), `hapi-bun-${label}-config-`))
      const lockPath = join(root, 'bun.lock')
      const lock = { ...fixture }
      if (configVersion === undefined) {
        delete lock.configVersion
      } else {
        lock.configVersion = configVersion
      }
      await writeFile(lockPath, JSON.stringify(lock))

      await expect(parseBunLockGraph(lockPath)).rejects.toThrow(/unsupported Bun configVersion/i)
    }
  })

  it('uses the highest-impact reachable role', () => {
    expect(['development', 'runtime'].sort((a, b) => roleImpact(b) - roleImpact(a))[0]).toBe('runtime')
    expect(['development', 'build'].sort((a, b) => roleImpact(b) - roleImpact(a))[0]).toBe('build')
  })
})
