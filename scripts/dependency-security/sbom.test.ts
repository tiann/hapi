import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { AdvisoryPolicy, DependencyGraph, DependencyRole, DependencyRoot, PackageNode } from './model'
import { buildCycloneDx, validateCycloneDx, writeSboms } from './sbom'

const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const BUN_LOCK_SHA = '1'.repeat(64)
const NPM_LOCK_SHA = '2'.repeat(64)
const AUDIT_SHA = '3'.repeat(64)
const EMPTY_SHA = createHash('sha256').update('').digest('hex')
const LIBRARY_BYTES = Buffer.alloc(64, 0xab)
const TOOL_BYTES = Buffer.alloc(64, 0xcd)
const LIBRARY_INTEGRITY = `sha512-${LIBRARY_BYTES.toString('base64')}`
const TOOL_INTEGRITY = `sha512-${TOOL_BYTES.toString('base64')}`

function root(path: string, name: string, role: DependencyRole): DependencyRoot {
  return {
    ref: `bun-workspaces:workspace:${path}`,
    name,
    path,
    role,
    dependencies: [],
  }
}

function libraryNode(lockKey: string, role: DependencyRole, workspace: string): PackageNode {
  return {
    ref: `bun-workspaces:${lockKey}`,
    lockSource: 'bun-workspaces',
    lockKey,
    name: '@fixture/library',
    version: '1.2.3',
    integrity: LIBRARY_INTEGRITY,
    purl: 'pkg:npm/%40fixture/library@1.2.3',
    platform: lockKey === 'nested/library' ? { os: ['darwin'], cpu: ['arm64'] } : null,
    roles: [role],
    paths: [[`bun-workspaces:workspace:${workspace}`, `bun-workspaces:${lockKey}`]],
  }
}

function graphs(): DependencyGraph[] {
  const bun: DependencyGraph = {
    source: 'bun-workspaces',
    lockPath: '/repo/bun.lock',
    lockSha256: BUN_LOCK_SHA,
    roots: [
      root('.', 'hapi', 'development'),
      root('cli', '@twsxtd/hapi', 'runtime'),
      root('docs', 'hapi-docs', 'build'),
      root('hub', 'hapi-hub', 'runtime'),
      root('shared', '@hapi/protocol', 'runtime'),
      root('web', 'hapi-web', 'runtime'),
      root('website', 'hapi-website', 'runtime'),
    ],
    nodes: [
      libraryNode('library', 'runtime', 'cli'),
      libraryNode('nested/library', 'build', 'docs'),
    ],
    edges: [
      { from: 'bun-workspaces:workspace:cli', to: 'bun-workspaces:library', kind: 'dependency' },
      { from: 'bun-workspaces:workspace:docs', to: 'bun-workspaces:nested/library', kind: 'dependency' },
    ],
  }
  const npm: DependencyGraph = {
    source: 'hapi-codex-sync',
    lockPath: '/repo/tools/hapi-codex-sync/package-lock.json',
    lockSha256: NPM_LOCK_SHA,
    roots: [{
      ref: 'hapi-codex-sync:workspace:tools/hapi-codex-sync',
      name: 'hapi-codex-sync',
      path: 'tools/hapi-codex-sync',
      role: 'runtime',
      dependencies: [],
    }],
    nodes: [{
      ref: 'hapi-codex-sync:node_modules/tool-library',
      lockSource: 'hapi-codex-sync',
      lockKey: 'node_modules/tool-library',
      name: 'tool-library',
      version: '4.5.6',
      integrity: TOOL_INTEGRITY,
      purl: 'pkg:npm/tool-library@4.5.6',
      platform: null,
      roles: ['runtime'],
      paths: [['hapi-codex-sync:workspace:tools/hapi-codex-sync', 'hapi-codex-sync:node_modules/tool-library']],
    }],
    edges: [{
      from: 'hapi-codex-sync:workspace:tools/hapi-codex-sync',
      to: 'hapi-codex-sync:node_modules/tool-library',
      kind: 'dependency',
    }],
  }
  return [bun, npm]
}

function policy(): AdvisoryPolicy {
  return {
    schemaVersion: 1,
    capturedOn: '2026-07-16',
    packageManagers: { bun: '1.3.11', npm: '11.4.2' },
    baseline: {
      'bun-workspaces': {
        lockSha256: BUN_LOCK_SHA,
        auditSha256: AUDIT_SHA,
        advisoryRows: 0,
        instanceCount: 0,
        instanceKeysSha256: EMPTY_SHA,
        severity: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
      'hapi-codex-sync': {
        lockSha256: NPM_LOCK_SHA,
        auditSha256: AUDIT_SHA,
        advisoryRows: 0,
        instanceCount: 0,
        instanceKeysSha256: EMPTY_SHA,
        severity: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
    currentLocks: { 'bun-workspaces': BUN_LOCK_SHA, 'hapi-codex-sync': NPM_LOCK_SHA },
    decisions: [],
    overrides: [],
  }
}

function properties(component: any, name: string): string[] {
  return (component.properties ?? [])
    .filter((property: any) => property.name === name)
    .map((property: any) => property.value)
}

describe('deterministic CycloneDX SBOM', () => {
  it('collapses identical libraries while retaining exact locks, roles, origins, platforms, and integrity', () => {
    const [bunGraph] = graphs()
    const first: any = buildCycloneDx(bunGraph, GIT_SHA, 'shipped')
    const second: any = buildCycloneDx(bunGraph, GIT_SHA, 'shipped')
    expect(second).toEqual(first)

    const workspacePaths = first.components
      .flatMap((component: any) => properties(component, 'hapi:workspace-path'))
      .sort()
    expect(workspacePaths).toEqual(['.', 'cli', 'docs', 'hub', 'shared', 'web', 'website'])

    const libraries = first.components.filter((component: any) => component.purl === 'pkg:npm/%40fixture/library@1.2.3')
    expect(libraries).toHaveLength(1)
    expect(properties(libraries[0], 'hapi:lock-key')).toEqual(['library', 'nested/library'])
    expect(properties(libraries[0], 'hapi:role')).toEqual(['build', 'runtime'])
    expect(properties(libraries[0], 'hapi:workspace-origin')).toEqual(['cli', 'docs'])
    expect(properties(libraries[0], 'hapi:platform-os')).toEqual(['darwin'])
    expect(properties(libraries[0], 'hapi:platform-cpu')).toEqual(['arm64'])
    expect(libraries[0].hashes).toEqual([{ alg: 'SHA-512', content: 'ab'.repeat(64) }])
    const mergedRef = libraries[0]['bom-ref']
    expect(first.dependencies.find((entry: any) => entry.ref === 'urn:hapi:workspace:cli').dependsOn).toEqual([mergedRef])
    expect(first.dependencies.find((entry: any) => entry.ref === 'urn:hapi:workspace:docs').dependsOn).toEqual([mergedRef])

    const missingIntegrity = graphs()[0]
    missingIntegrity.nodes[0].integrity = null
    expect(() => buildCycloneDx(missingIntegrity, GIT_SHA, 'shipped')).toThrow(/no SHA-512 registry integrity/i)
  })

  it('writes both scopes twice as identical bytes and validates the official 1.6 schema', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'hapi-sbom-'))
    const policyPath = join(temporary, 'advisory-matrix.json')
    await writeFile(policyPath, `${JSON.stringify(policy(), null, 2)}\n`)
    const firstDirectory = join(temporary, 'first')
    const secondDirectory = join(temporary, 'second')
    await mkdir(firstDirectory)
    await mkdir(secondDirectory)

    const first = await writeSboms({ graphs: graphs(), policyPath, gitSha: GIT_SHA, outputDirectory: firstDirectory })
    const second = await writeSboms({ graphs: graphs(), policyPath, gitSha: GIT_SHA, outputDirectory: secondDirectory })
    for (const filename of ['hapi.cdx.json', 'hapi-codex-sync.cdx.json', 'hapi-sbom-manifest.json']) {
      const firstBytes = await readFile(join(firstDirectory, filename))
      const secondBytes = await readFile(join(secondDirectory, filename))
      expect(secondBytes).toEqual(firstBytes)
      expect(firstBytes.toString('utf8')).not.toContain('"timestamp"')
    }
    expect(second.hashes).toEqual(first.hashes)

    const bunDocument: any = JSON.parse(await readFile(first.bunPath, 'utf8'))
    const npmDocument: any = JSON.parse(await readFile(first.npmPath, 'utf8'))
    expect(properties(npmDocument.metadata.component, 'hapi:distribution-scope')).toEqual(['not-shipped-with-cli'])
    expect(npmDocument.components[0].hashes).toEqual([{ alg: 'SHA-512', content: 'cd'.repeat(64) }])

    const schemaDirectory = resolve('security/dependencies/schemas')
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(' ')) }
    try {
      expect(() => validateCycloneDx(bunDocument, schemaDirectory)).not.toThrow()
      expect(() => validateCycloneDx(npmDocument, schemaDirectory)).not.toThrow()
    } finally {
      console.warn = originalWarn
    }
    expect(warnings).toEqual([])
  })

  it('co-locates release SBOMs only with a successful dependency-gate receipt', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'hapi-sbom-gate-'))
    const policyPath = join(temporary, 'advisory-matrix.json')
    await writeFile(policyPath, `${JSON.stringify(policy(), null, 2)}\n`)

    const successful = join(temporary, 'successful')
    await mkdir(successful)
    const summary = `${JSON.stringify({ ok: true, summary: {}, violations: [] }, null, 2)}\n`
    await writeFile(join(successful, 'dependency-audit-summary.json'), summary)
    await writeFile(join(successful, 'dependency-gate-metadata.json'), '{"schemaVersion":1}\n')
    await writeSboms({ graphs: graphs(), policyPath, gitSha: GIT_SHA, outputDirectory: successful })
    expect(await readFile(join(successful, 'dependency-audit-summary.json'), 'utf8')).toBe(summary)
    expect(await Bun.file(join(successful, 'hapi-sbom-manifest.json')).exists()).toBe(true)

    const failed = join(temporary, 'failed')
    await mkdir(failed)
    await writeFile(join(failed, 'dependency-audit-summary.json'), '{"ok":false}\n')
    await expect(writeSboms({ graphs: graphs(), policyPath, gitSha: GIT_SHA, outputDirectory: failed })).rejects.toThrow(/successful dependency gate/i)

    const unexpected = join(temporary, 'unexpected')
    await mkdir(unexpected)
    await writeFile(join(unexpected, 'sentinel.txt'), 'preserve-me\n')
    await expect(writeSboms({ graphs: graphs(), policyPath, gitSha: GIT_SHA, outputDirectory: unexpected })).rejects.toThrow(/unexpected pre-existing/i)
    expect(await readFile(join(unexpected, 'sentinel.txt'), 'utf8')).toBe('preserve-me\n')
  })
})
