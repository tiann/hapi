import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { GateResult } from './model'
import { parseNpmAudit } from './audit'
import {
  runCli,
  runDependencyInventory,
  type CliOperations,
  type InventoryOptions,
} from './cli'

type Capture = { stdout: string; stderr: string }

function successGate(): GateResult {
  return { ok: true, violations: [], current: [], summary: {} }
}

function operations(overrides: Partial<CliOperations> = {}): CliOperations {
  return {
    inventory: async (options) => ({
      outputPaths: [join(options.outputDirectory, 'advisory-matrix.candidate.json')],
    }),
    gate: async () => successGate(),
    sbom: async (options) => ({
      bunPath: join(options.outputDirectory, 'hapi.cdx.json'),
      npmPath: join(options.outputDirectory, 'hapi-codex-sync.cdx.json'),
      manifestPath: join(options.outputDirectory, 'hapi-sbom-manifest.json'),
      hashes: {},
    }),
    ...overrides,
  }
}

async function invoke(
  argv: string[],
  operationOverrides: Partial<CliOperations> = {},
  cwd = '/repo',
): Promise<{ code: number; capture: Capture }> {
  const capture = { stdout: '', stderr: '' }
  const code = await runCli(argv, {
    cwd,
    operations: operations(operationOverrides),
    stdout: (value) => { capture.stdout += value },
    stderr: (value) => { capture.stderr += value },
  })
  return { code, capture }
}

describe('dependency governance CLI', () => {
  it('dispatches inventory with all baseline and paired current inputs and stable paths', async () => {
    let received: InventoryOptions | undefined
    const { code, capture } = await invoke([
      'inventory',
      '--out', '.hapi-work/inventory',
      '--as-of', '2026-07-16',
      '--baseline-bun-lock', '/evidence/bun.lock',
      '--baseline-npm-lock', '/evidence/package-lock.json',
      '--baseline-bun-audit-json', '/evidence/bun-audit.json',
      '--baseline-npm-audit-json', '/evidence/npm-audit.json',
      '--bun-audit-json', '/current/bun-audit.json',
      '--npm-audit-json', '/current/npm-audit.json',
    ], {
      inventory: async (options) => {
        received = options
        return {
          outputPaths: [
            join(options.outputDirectory, 'advisory-matrix.candidate.json'),
            join(options.outputDirectory, 'baseline-affected-instances.json'),
          ],
        }
      },
    })
    expect(code).toBe(0)
    expect(received).toEqual({
      repositoryRoot: '/repo',
      outputDirectory: '/repo/.hapi-work/inventory',
      asOf: '2026-07-16',
      baselineBunLockPath: '/evidence/bun.lock',
      baselineNpmLockPath: '/evidence/package-lock.json',
      baselineBunAuditJsonPath: '/evidence/bun-audit.json',
      baselineNpmAuditJsonPath: '/evidence/npm-audit.json',
      bunAuditJsonPath: '/current/bun-audit.json',
      npmAuditJsonPath: '/current/npm-audit.json',
    })
    expect(capture.stderr).toBe('')
    expect(capture.stdout).toBe('/repo/.hapi-work/inventory/advisory-matrix.candidate.json\n/repo/.hapi-work/inventory/baseline-affected-instances.json\n')
  })

  it('maps a gate policy violation to one and passes paired explicit audits', async () => {
    let received: any
    const blocked: GateResult = {
      ok: false,
      violations: [{ code: 'fixture', key: 'fixture', message: 'blocked', path: [] }],
      current: [],
      summary: {},
    }
    const { code, capture } = await invoke([
      'gate',
      '--out', '.hapi-work/gate',
      '--as-of', '2026-07-16',
      '--bun-audit-json', '/current/bun.json',
      '--npm-audit-json', '/current/npm.json',
    ], {
      gate: async (options) => {
        received = options
        return blocked
      },
    })
    expect(code).toBe(1)
    expect(received).toEqual({
      repositoryRoot: '/repo',
      policyPath: '/repo/security/dependencies/advisory-matrix.json',
      outputDirectory: '/repo/.hapi-work/gate',
      asOf: '2026-07-16',
      bunAuditJsonPath: '/current/bun.json',
      npmAuditJsonPath: '/current/npm.json',
    })
    expect(capture.stdout).toBe('/repo/.hapi-work/gate/dependency-audit-summary.json\n')
    expect(capture.stderr).toBe('')
  })

  it('requires an explicit clean 40-hex identity for SBOM dispatch', async () => {
    let received: any
    const { code, capture } = await invoke([
      'sbom',
      '--out', '.hapi-work/sbom',
      '--git-sha', '0123456789abcdef0123456789abcdef01234567',
    ], {
      sbom: async (options) => {
        received = options
        return {
          bunPath: join(options.outputDirectory, 'hapi.cdx.json'),
          npmPath: join(options.outputDirectory, 'hapi-codex-sync.cdx.json'),
          manifestPath: join(options.outputDirectory, 'hapi-sbom-manifest.json'),
          hashes: {},
        }
      },
    })
    expect(code).toBe(0)
    expect(received).toEqual({
      graphs: undefined,
      policyPath: '/repo/security/dependencies/advisory-matrix.json',
      repositoryRoot: '/repo',
      outputDirectory: '/repo/.hapi-work/sbom',
      gitSha: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(capture.stdout).toBe([
      '/repo/.hapi-work/sbom/hapi.cdx.json',
      '/repo/.hapi-work/sbom/hapi-codex-sync.cdx.json',
      '/repo/.hapi-work/sbom/hapi-sbom-manifest.json',
      '',
    ].join('\n'))
  })

  it('rejects unknown, incomplete, unpaired, unsafe, and implicit inputs before dispatch', async () => {
    let calls = 0
    const never: Partial<CliOperations> = {
      inventory: async () => { calls += 1; throw new Error('must not run') },
      gate: async () => { calls += 1; throw new Error('must not run') },
      sbom: async () => { calls += 1; throw new Error('must not run') },
    }
    const cases = [
      ['inventory', '--unknown', 'x'],
      ['inventory', '--out', '.hapi-work/x', '--as-of', '2026-07-16'],
      [
        'inventory',
        '--out', 'security/dependencies',
        '--as-of', '2026-07-16',
        '--baseline-bun-lock', '/b',
        '--baseline-npm-lock', '/n',
        '--baseline-bun-audit-json', '/ba',
        '--baseline-npm-audit-json', '/na',
      ],
      ['gate', '--out', '.hapi-work/x', '--as-of', '2026-07-16', '--bun-audit-json', '/only-one.json'],
      ['gate', '--out', '.hapi-work/x', '--as-of', '2026-02-30'],
      ['sbom', '--out', '.hapi-work/x'],
      ['sbom', '--out', '.hapi-work/x', '--git-sha', 'HEAD'],
      ['unknown-command', '--out', '.hapi-work/x'],
    ]
    for (const argv of cases) {
      const result = await invoke(argv, never)
      expect(result.code, argv.join(' ')).toBe(2)
      expect(result.capture.stderr.length, argv.join(' ')).toBeGreaterThan(0)
    }
    expect(calls).toBe(0)
  })

  it('maps parser, audit, and write failures to two without leaking credential-like values', async () => {
    const previous = process.env.HAPI_CLI_SECRET
    process.env.HAPI_CLI_SECRET = 'TOP_SECRET_VALUE'
    try {
      const result = await invoke([
        'gate', '--out', '.hapi-work/x', '--as-of', '2026-07-16',
      ], {
        gate: async () => {
          const credentialUrl = [
            'https://user',
            ':',
            process.env.HAPI_CLI_SECRET,
            '@example.invalid',
          ].join('')
          throw new Error(`network ${credentialUrl} token=${process.env.HAPI_CLI_SECRET}`)
        },
      })
      expect(result.code).toBe(2)
      expect(result.capture.stderr).not.toContain('TOP_SECRET_VALUE')
      expect(result.capture.stderr).toContain('[REDACTED]')
    } finally {
      if (previous === undefined) delete process.env.HAPI_CLI_SECRET
      else process.env.HAPI_CLI_SECRET = previous
    }
  })

  it('maps missing or contradictory npm metadata to operational exit two', async () => {
    for (const stdout of [
      '{"auditReportVersion":2,"vulnerabilities":{}}',
      '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0,"total":1}}}',
    ]) {
      const result = await invoke([
        'gate', '--out', '.hapi-work/x', '--as-of', '2026-07-16',
      ], {
        gate: async () => {
          parseNpmAudit(stdout)
          return successGate()
        },
      })
      expect(result.code).toBe(2)
      expect(result.capture.stderr).toContain('dependency-security:')
    }
  })

  it('refuses a non-empty inventory output directory before reading any input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-inventory-nonempty-'))
    const outputDirectory = join(root, 'output')
    const sentinel = join(outputDirectory, 'sentinel.txt')
    await mkdir(outputDirectory)
    await writeFile(sentinel, 'preserve\n')
    await expect(runDependencyInventory({
      repositoryRoot: root,
      outputDirectory,
      asOf: '2026-07-16',
      baselineBunLockPath: join(root, 'missing-bun.lock'),
      baselineNpmLockPath: join(root, 'missing-package-lock.json'),
      baselineBunAuditJsonPath: join(root, 'missing-bun-audit.json'),
      baselineNpmAuditJsonPath: join(root, 'missing-npm-audit.json'),
    })).rejects.toThrow(/output directory.*not empty/i)
    expect(await readFile(sentinel, 'utf8')).toBe('preserve\n')
  })

  it('writes deterministic candidate-only inventory in explicit and fresh modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-inventory-fixture-'))
    await mkdir(join(root, 'tools/hapi-codex-sync'), { recursive: true })
    await copyFile('scripts/dependency-security/fixtures/bun.lock.fixture', join(root, 'bun.lock'))
    await copyFile('scripts/dependency-security/fixtures/package-lock.fixture.json', join(root, 'tools/hapi-codex-sync/package-lock.json'))
    const bunWithJsonc = Bun as typeof Bun & { JSONC: { parse(input: string): unknown } }
    const lock = bunWithJsonc.JSONC.parse(await Bun.file(join(root, 'bun.lock')).text()) as {
      workspaces: Record<string, { name: string; version?: string }>
    }
    for (const [path, workspace] of Object.entries(lock.workspaces)) {
      const directory = path ? join(root, path) : root
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), `${JSON.stringify({
        name: workspace.name,
        version: workspace.version ?? '1.0.0',
        private: true,
      }, null, 2)}\n`)
    }
    await writeFile(join(root, 'tools/hapi-codex-sync/package.json'), '{"name":"hapi-codex-sync-fixture","version":"1.0.0","private":true}\n')

    const bunAudit = '{"duplicate":[{"id":4001,"url":"https://github.com/advisories/GHSA-inventory","title":"inventory fixture","severity":"moderate","vulnerable_versions":"<2.0.0"}]}\n'
    const npmAudit = '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}\n'
    const bunAuditPath = join(root, 'bun-audit.json')
    const npmAuditPath = join(root, 'npm-audit.json')
    await writeFile(bunAuditPath, bunAudit)
    await writeFile(npmAuditPath, npmAudit)

    const explicitOne = join(root, 'inventory-explicit-one')
    const explicitTwo = join(root, 'inventory-explicit-two')
    const common: Omit<InventoryOptions, 'outputDirectory'> = {
      repositoryRoot: root,
      asOf: '2026-07-16',
      baselineBunLockPath: join(root, 'bun.lock'),
      baselineNpmLockPath: join(root, 'tools/hapi-codex-sync/package-lock.json'),
      baselineBunAuditJsonPath: bunAuditPath,
      baselineNpmAuditJsonPath: npmAuditPath,
      bunAuditJsonPath: bunAuditPath,
      npmAuditJsonPath: npmAuditPath,
    }
    await runDependencyInventory({ ...common, outputDirectory: explicitOne })
    await runDependencyInventory({ ...common, outputDirectory: explicitTwo })
    for (const filename of [
      'advisory-matrix.candidate.json',
      'baseline-affected-instances.json',
      'current-affected-instances.json',
      'dependency-inventory-summary.json',
      'dependency-inventory-metadata.json',
      'bun-audit-production.json',
      'npm-audit-production.json',
    ]) {
      expect(await readFile(join(explicitTwo, filename))).toEqual(await readFile(join(explicitOne, filename)))
    }
    const candidate = JSON.parse(await readFile(join(explicitOne, 'advisory-matrix.candidate.json'), 'utf8'))
    expect(candidate.baseline['bun-workspaces'].advisoryRows).toBe(1)
    expect(candidate.baseline['bun-workspaces'].severity.moderate).toBe(1)
    expect(candidate.decisions).toHaveLength(1)
    expect(candidate.decisions[0]).toMatchObject({
      baseline: true,
      disposition: 'accepted-risk',
      owner: '',
      reviewedOn: '2026-07-16',
      expiresOn: '2026-10-14',
    })
    const summary = JSON.parse(await readFile(join(explicitOne, 'dependency-inventory-summary.json'), 'utf8'))
    expect(summary.runtime.moderate).toBe(1)
    expect(await Bun.file(join(root, 'security/dependencies/advisory-matrix.json')).exists()).toBe(false)
    expect(await Bun.file(join(explicitOne, 'bun-audit-production.stderr')).exists()).toBe(false)

    const fakeBin = join(root, 'fake-bin')
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, 'bun'), `#!/bin/sh\ncat "$FAKE_BUN_AUDIT"\nprintf 'fresh bun stderr\\n' >&2\nexit 1\n`)
    await writeFile(join(fakeBin, 'npm'), `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '11.4.2\\n'; exit 0; fi\ncat "$FAKE_NPM_AUDIT"\nprintf 'fresh npm stderr\\n' >&2\nexit 0\n`)
    await chmod(join(fakeBin, 'bun'), 0o755)
    await chmod(join(fakeBin, 'npm'), 0o755)
    const previousPath = process.env.PATH
    const previousBun = process.env.FAKE_BUN_AUDIT
    const previousNpm = process.env.FAKE_NPM_AUDIT
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    process.env.FAKE_BUN_AUDIT = bunAuditPath
    process.env.FAKE_NPM_AUDIT = npmAuditPath
    const freshOutput = join(root, 'inventory-fresh')
    try {
      const freshOptions = { ...common, outputDirectory: freshOutput }
      delete freshOptions.bunAuditJsonPath
      delete freshOptions.npmAuditJsonPath
      await runDependencyInventory(freshOptions)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousBun === undefined) delete process.env.FAKE_BUN_AUDIT
      else process.env.FAKE_BUN_AUDIT = previousBun
      if (previousNpm === undefined) delete process.env.FAKE_NPM_AUDIT
      else process.env.FAKE_NPM_AUDIT = previousNpm
    }
    const freshFiles = await readdir(freshOutput)
    for (const filename of [
      'bun-audit-production.json',
      'bun-audit-production.stderr',
      'bun-audit-production.status',
      'npm-audit-production.json',
      'npm-audit-production.stderr',
      'npm-audit-production.status',
    ]) {
      expect(freshFiles).toContain(filename)
    }
    expect(await readFile(join(freshOutput, 'bun-audit-production.status'), 'utf8')).toBe('1\n')
    expect(await readFile(join(freshOutput, 'npm-audit-production.status'), 'utf8')).toBe('0\n')
    expect(await readFile(join(freshOutput, 'bun-audit-production.stderr'), 'utf8')).toBe('fresh bun stderr\n')
  })
})
