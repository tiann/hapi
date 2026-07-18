import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { AdvisoryDecision, AdvisoryPolicy, AffectedInstance, Severity } from './model'
import { matchAffectedInstances, parseBunAudit, parseNpmAudit } from './audit'
import { gateExitCode, runDependencyGate } from './gate'
import { parseBunLockGraph, parseNpmLockGraph } from './lockGraph'

const AS_OF = '2026-07-16'
const BUN_AUDIT = '{"duplicate":[{"id":3001,"url":"https://github.com/advisories/GHSA-gate-fixture","title":"gate fixture","severity":"moderate","vulnerable_versions":"<2.0.0"}]}\n'
const NPM_AUDIT = '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}\n}\n'

type Fixture = {
  root: string
  policyPath: string
  bunAuditPath: string
  npmAuditPath: string
  policy: AdvisoryPolicy
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function severityCounts(current: AffectedInstance[]): Record<Severity, number> {
  const result: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const item of current) result[item.advisory.severity] += 1
  return result
}

function instanceKeySha(current: AffectedInstance[]): string {
  const keys = current.map((item) => item.key).sort()
  return sha256(keys.length === 0 ? '' : `${keys.join('\n')}\n`)
}

function decisionFromAffected(item: AffectedInstance): AdvisoryDecision {
  return {
    key: item.key,
    baseline: true,
    advisory: {
      url: item.advisory.url,
      title: item.advisory.title,
      severity: item.advisory.severity,
      vulnerableRange: item.advisory.vulnerableRange,
    },
    instance: {
      source: item.node.lockSource,
      packageName: item.node.name,
      version: item.node.version,
      lockKey: item.node.lockKey,
    },
    automaticRole: item.automaticRole,
    classification: item.automaticRole,
    dependencyPaths: structuredClone(item.dependencyPaths),
    disposition: 'accepted-risk',
    owner: 'hapi-maintainers',
    rationale: 'This moderate fixture advisory is time bounded while its same-major dependency patch and regression coverage are verified.',
    evidence: ['scripts/dependency-security/gate.test.ts', 'bun test scripts/dependency-security/gate.test.ts'],
    reviewedOn: AS_OF,
    expiresOn: '2026-10-14',
  }
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode})\n${stdout}\n${stderr}`)
}

async function createFixture(options: {
  manifestOverrides?: Record<string, string>
  policyOverrides?: AdvisoryPolicy['overrides']
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'hapi-dependency-gate-'))
  await mkdir(join(root, 'tools/hapi-codex-sync'), { recursive: true })
  await copyFile('scripts/dependency-security/fixtures/bun.lock.fixture', join(root, 'bun.lock'))
  await copyFile('scripts/dependency-security/fixtures/package-lock.fixture.json', join(root, 'tools/hapi-codex-sync/package-lock.json'))

  const bunWithJsonc = Bun as typeof Bun & { JSONC: { parse(input: string): unknown } }
  const bunLock = bunWithJsonc.JSONC.parse(await Bun.file(join(root, 'bun.lock')).text()) as {
    workspaces: Record<string, { name: string; version?: string }>
  }
  for (const [path, workspace] of Object.entries(bunLock.workspaces)) {
    const directory = path ? join(root, path) : root
    await mkdir(directory, { recursive: true })
    const manifest: Record<string, unknown> = { name: workspace.name, version: workspace.version ?? '1.0.0', private: true }
    if (path === '' && options.manifestOverrides) manifest.overrides = options.manifestOverrides
    await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  await writeFile(join(root, 'tools/hapi-codex-sync/package.json'), '{"name":"hapi-codex-sync-fixture","version":"1.0.0","private":true}\n')

  const bunAuditPath = join(root, 'bun-audit-input.json')
  const npmAuditPath = join(root, 'npm-audit-input.json')
  await writeFile(bunAuditPath, BUN_AUDIT)
  await writeFile(npmAuditPath, NPM_AUDIT)

  const bunGraph = await parseBunLockGraph(join(root, 'bun.lock'))
  const npmGraph = await parseNpmLockGraph(join(root, 'tools/hapi-codex-sync/package-lock.json'))
  const bunCurrent = matchAffectedInstances(bunGraph, parseBunAudit(BUN_AUDIT))
  const npmCurrent = matchAffectedInstances(npmGraph, parseNpmAudit(NPM_AUDIT))
  const decisions = [...bunCurrent, ...npmCurrent].map(decisionFromAffected)
  const emptySha = sha256('')
  const policy: AdvisoryPolicy = {
    schemaVersion: 1,
    capturedOn: AS_OF,
    packageManagers: { bun: Bun.version, npm: '11.4.2' },
    baseline: {
      'bun-workspaces': {
        lockSha256: bunGraph.lockSha256,
        auditSha256: sha256(BUN_AUDIT),
        advisoryRows: 1,
        instanceCount: bunCurrent.length,
        instanceKeysSha256: instanceKeySha(bunCurrent),
        severity: severityCounts(bunCurrent),
      },
      'hapi-codex-sync': {
        lockSha256: npmGraph.lockSha256,
        auditSha256: sha256(NPM_AUDIT),
        advisoryRows: 0,
        instanceCount: 0,
        instanceKeysSha256: emptySha,
        severity: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
    currentLocks: {
      'bun-workspaces': bunGraph.lockSha256,
      'hapi-codex-sync': npmGraph.lockSha256,
    },
    decisions,
    overrides: options.policyOverrides ?? [],
  }
  const policyPath = join(root, 'security/dependencies/advisory-matrix.json')
  await mkdir(join(root, 'security/dependencies'), { recursive: true })
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`)

  await run(['git', 'init', '-q'], root)
  await run(['git', 'add', '.'], root)
  await run(['git', '-c', 'user.name=HAPI Test', '-c', 'user.email=hapi-test@example.invalid', 'commit', '-qm', 'fixture'], root)
  return { root, policyPath, bunAuditPath, npmAuditPath, policy }
}

async function runExplicit(fixture: Fixture, outputDirectory: string) {
  return runDependencyGate({
    repositoryRoot: fixture.root,
    policyPath: fixture.policyPath,
    outputDirectory,
    asOf: AS_OF,
    bunAuditJsonPath: fixture.bunAuditPath,
    npmAuditJsonPath: fixture.npmAuditPath,
  })
}

const validOverride: AdvisoryPolicy['overrides'][number] = {
  packageName: 'fast-uri',
  selectedVersion: '4.1.0',
  blockedBy: 'ajv@8.20.0 requires fast-uri ^3.0.1',
  owner: 'hapi-maintainers',
  rationale: 'The selected version preserves the public API used by Ajv while its parent range catches up.',
  evidence: ['scripts/dependency-security/gate.test.ts', 'bun test scripts/dependency-security/gate.test.ts'],
  reviewedOn: AS_OF,
  expiresOn: '2026-08-15',
}

describe('dependency gate', () => {
  it('maps valid outcomes to exact process exit codes and rejects dual or empty input', () => {
    const ok = { ok: true, violations: [], current: [], summary: {} }
    const blocked = { ok: false, violations: [{ code: 'x', key: 'x', message: 'x', path: [] }], current: [], summary: {} }
    expect(gateExitCode({ result: ok })).toBe(0)
    expect(gateExitCode({ result: blocked })).toBe(1)
    expect(gateExitCode({ error: new Error('network') })).toBe(2)
    expect(gateExitCode({})).toBe(2)
    expect(gateExitCode({ result: ok, error: new Error('dual') })).toBe(2)
    expect(gateExitCode({ result: { ...ok, ok: false } })).toBe(2)
  })

  it('writes byte-stable explicit-file evidence without inventing command receipts', async () => {
    const fixture = await createFixture()
    const firstDirectory = join(fixture.root, 'out-explicit-one')
    const secondDirectory = join(fixture.root, 'out-explicit-two')
    const first = await runExplicit(fixture, firstDirectory)
    const second = await runExplicit(fixture, secondDirectory)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)

    const stableFiles = [
      'bun-audit-production.json',
      'npm-audit-production.json',
      'dependency-affected-instances.json',
      'dependency-audit-summary.json',
      'dependency-audit-summary.txt',
      'dependency-gate-metadata.json',
    ]
    for (const file of stableFiles) {
      expect(await readFile(join(firstDirectory, file))).toEqual(await readFile(join(secondDirectory, file)))
    }
    expect(await readFile(join(firstDirectory, 'bun-audit-production.json'), 'utf8')).toBe(BUN_AUDIT)
    expect(await readFile(join(firstDirectory, 'npm-audit-production.json'), 'utf8')).toBe(NPM_AUDIT)
    expect(await Bun.file(join(firstDirectory, 'bun-audit-production.stderr')).exists()).toBe(false)
    expect(await Bun.file(join(firstDirectory, 'bun-audit-production.status')).exists()).toBe(false)
    const allOutput = (await Promise.all(stableFiles.map((file) => readFile(join(firstDirectory, file), 'utf8')))).join('\n')
    expect(allOutput).not.toContain('HAPI_GATE_SECRET_SENTINEL')
  })

  it('refuses to mix evidence into a non-empty output directory', async () => {
    const fixture = await createFixture()
    const outputDirectory = join(fixture.root, 'out-existing')
    const sentinelPath = join(outputDirectory, 'sentinel.txt')
    await mkdir(outputDirectory)
    await writeFile(sentinelPath, 'preserve-me\n')
    await expect(runExplicit(fixture, outputDirectory)).rejects.toThrow(/output directory.*not empty/i)
    expect(await readFile(sentinelPath, 'utf8')).toBe('preserve-me\n')
  })

  it('preserves every fresh audit receipt before evaluating it', async () => {
    const fixture = await createFixture()
    const fakeBin = join(fixture.root, 'fake-bin')
    await mkdir(fakeBin)
    const fakeBun = join(fakeBin, 'bun')
    const fakeNpm = join(fakeBin, 'npm')
    await writeFile(fakeBun, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '1.3.11\\n'; exit 0; fi\ncat "$FAKE_BUN_AUDIT"\nprintf 'fixture bun stderr\\n' >&2\nexit 1\n`)
    await writeFile(fakeNpm, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '11.4.2\\n'; exit 0; fi\ncat "$FAKE_NPM_AUDIT"\nprintf 'fixture npm stderr\\n' >&2\nexit 0\n`)
    await chmod(fakeBun, 0o755)
    await chmod(fakeNpm, 0o755)

    const previousPath = process.env.PATH
    const previousBunAudit = process.env.FAKE_BUN_AUDIT
    const previousNpmAudit = process.env.FAKE_NPM_AUDIT
    const previousSecret = process.env.HAPI_GATE_SECRET
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    process.env.FAKE_BUN_AUDIT = fixture.bunAuditPath
    process.env.FAKE_NPM_AUDIT = fixture.npmAuditPath
    process.env.HAPI_GATE_SECRET = 'HAPI_GATE_SECRET_SENTINEL'
    const outputDirectory = join(fixture.root, 'out-fresh')
    try {
      const result = await runDependencyGate({
        repositoryRoot: fixture.root,
        policyPath: fixture.policyPath,
        outputDirectory,
        asOf: AS_OF,
      })
      expect(result.ok).toBe(true)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousBunAudit === undefined) delete process.env.FAKE_BUN_AUDIT
      else process.env.FAKE_BUN_AUDIT = previousBunAudit
      if (previousNpmAudit === undefined) delete process.env.FAKE_NPM_AUDIT
      else process.env.FAKE_NPM_AUDIT = previousNpmAudit
      if (previousSecret === undefined) delete process.env.HAPI_GATE_SECRET
      else process.env.HAPI_GATE_SECRET = previousSecret
    }

    const files = await readdir(outputDirectory)
    for (const required of [
      'bun-audit-production.json',
      'bun-audit-production.stderr',
      'bun-audit-production.status',
      'npm-audit-production.json',
      'npm-audit-production.stderr',
      'npm-audit-production.status',
      'dependency-affected-instances.json',
      'dependency-audit-summary.json',
      'dependency-audit-summary.txt',
      'dependency-gate-metadata.json',
    ]) {
      expect(files).toContain(required)
    }
    expect(await readFile(join(outputDirectory, 'bun-audit-production.status'), 'utf8')).toBe('1\n')
    expect(await readFile(join(outputDirectory, 'npm-audit-production.status'), 'utf8')).toBe('0\n')
    expect(await readFile(join(outputDirectory, 'bun-audit-production.stderr'), 'utf8')).toBe('fixture bun stderr\n')
    const allOutput = (await Promise.all(files.map((file) => readFile(join(outputDirectory, file), 'utf8')))).join('\n')
    expect(allOutput).not.toContain('HAPI_GATE_SECRET_SENTINEL')
  })

  it('fails policy on unregistered, drifting, and stale manifest overrides but accepts an exact registration', async () => {
    const cases = [
      {
        name: 'unregistered manifest override',
        expected: 'manifest-override-unregistered',
        fixture: () => createFixture({ manifestOverrides: { 'fast-uri': '4.1.0' } }),
      },
      {
        name: 'registered override drift',
        expected: 'override-version-drift',
        fixture: () => createFixture({ manifestOverrides: { 'fast-uri': '4.0.0' }, policyOverrides: [validOverride] }),
      },
      {
        name: 'stale policy override',
        expected: 'policy-override-stale',
        fixture: () => createFixture({ policyOverrides: [validOverride] }),
      },
    ]
    for (const testCase of cases) {
      const fixture = await testCase.fixture()
      const result = await runExplicit(fixture, join(fixture.root, 'out-override'))
      expect(result.violations.map((entry) => entry.code), testCase.name).toContain(testCase.expected)
    }

    const valid = await createFixture({ manifestOverrides: { 'fast-uri': '4.1.0' }, policyOverrides: [validOverride] })
    expect((await runExplicit(valid, join(valid.root, 'out-valid-override'))).ok).toBe(true)
  })
})
