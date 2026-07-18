import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import type {
  AdvisoryDecision,
  AdvisoryPolicy,
  AffectedInstance,
  DependencyGraph,
  DependencyRole,
  Severity,
} from './model'
import { evaluatePolicy, parsePolicy } from './policy'

const acceptedBuildHigh: AdvisoryDecision = {
  key: 'bun-workspaces|https://github.com/advisories/GHSA-build|vite|5.4.21|vitepress/vite',
  baseline: true,
  advisory: { url: 'https://github.com/advisories/GHSA-build', title: 'build advisory', severity: 'high', vulnerableRange: '<6.0.0' },
  instance: { source: 'bun-workspaces', packageName: 'vite', version: '5.4.21', lockKey: 'vitepress/vite' },
  automaticRole: 'build',
  classification: 'build',
  dependencyPaths: [['bun-workspaces:workspace:docs', 'bun-workspaces:vitepress', 'bun-workspaces:vitepress/vite']],
  disposition: 'accepted-risk',
  owner: 'hapi-maintainers',
  rationale: 'The affected Vite instance is used only by the static documentation build and is not shipped or started by HAPI runtime entrypoints.',
  evidence: ['docs/package.json', 'bun run --cwd docs docs:build'],
  reviewedOn: '2026-07-16',
  expiresOn: '2026-08-15',
}

const BUN_LOCK = 'a'.repeat(64)
const NPM_LOCK = 'b'.repeat(64)
const EMPTY_SHA = createHash('sha256').update('').digest('hex')

function clone<T>(value: T): T {
  return structuredClone(value)
}

function affectedFromDecision(decision: AdvisoryDecision): AffectedInstance {
  const ref = `${decision.instance.source}:${decision.instance.lockKey}`
  return {
    key: decision.key,
    advisory: {
      source: decision.instance.source,
      id: decision.advisory.url.split('/').at(-1) ?? decision.advisory.url,
      url: decision.advisory.url,
      title: decision.advisory.title,
      severity: decision.advisory.severity,
      vulnerableRange: decision.advisory.vulnerableRange,
      packageName: decision.instance.packageName,
    },
    node: {
      ref,
      lockSource: decision.instance.source,
      lockKey: decision.instance.lockKey,
      name: decision.instance.packageName,
      version: decision.instance.version,
      integrity: 'sha512-cG9saWN5',
      purl: `pkg:npm/${decision.instance.packageName}@${decision.instance.version}`,
      platform: null,
      roles: [decision.automaticRole],
      paths: clone(decision.dependencyPaths),
    },
    automaticRole: decision.automaticRole,
    dependencyPaths: clone(decision.dependencyPaths),
  }
}

function countSeverities(decisions: AdvisoryDecision[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const decision of decisions.filter((entry) => entry.baseline)) counts[decision.advisory.severity] += 1
  return counts
}

function baselineKeySha(decisions: AdvisoryDecision[]): string {
  const keys = decisions.filter((entry) => entry.baseline).map((entry) => entry.key).sort()
  const payload = keys.length === 0 ? '' : `${keys.join('\n')}\n`
  return createHash('sha256').update(payload).digest('hex')
}

function makePolicy(decisions: AdvisoryDecision[] = [clone(acceptedBuildHigh)]): AdvisoryPolicy {
  const bunBaseline = decisions.filter((entry) => entry.baseline && entry.instance.source === 'bun-workspaces')
  const npmBaseline = decisions.filter((entry) => entry.baseline && entry.instance.source === 'hapi-codex-sync')
  return {
    schemaVersion: 1,
    capturedOn: '2026-07-16',
    packageManagers: { bun: '1.3.11', npm: '11.4.2' },
    baseline: {
      'bun-workspaces': {
        lockSha256: BUN_LOCK,
        auditSha256: 'c'.repeat(64),
        advisoryRows: new Set(bunBaseline.map((entry) => `${entry.advisory.url}\0${entry.instance.packageName}`)).size,
        instanceCount: bunBaseline.length,
        instanceKeysSha256: baselineKeySha(bunBaseline),
        severity: countSeverities(bunBaseline),
      },
      'hapi-codex-sync': {
        lockSha256: NPM_LOCK,
        auditSha256: 'd'.repeat(64),
        advisoryRows: new Set(npmBaseline.map((entry) => `${entry.advisory.url}\0${entry.instance.packageName}`)).size,
        instanceCount: npmBaseline.length,
        instanceKeysSha256: npmBaseline.length === 0 ? EMPTY_SHA : baselineKeySha(npmBaseline),
        severity: countSeverities(npmBaseline),
      },
    },
    currentLocks: { 'bun-workspaces': BUN_LOCK, 'hapi-codex-sync': NPM_LOCK },
    decisions: clone(decisions),
    overrides: [],
  }
}

function graphs(): DependencyGraph[] {
  return [
    { source: 'bun-workspaces', lockPath: '/repo/bun.lock', lockSha256: BUN_LOCK, roots: [], nodes: [], edges: [] },
    { source: 'hapi-codex-sync', lockPath: '/repo/tools/hapi-codex-sync/package-lock.json', lockSha256: NPM_LOCK, roots: [], nodes: [], edges: [] },
  ]
}

function runtimeDecision(severity: Severity = 'high'): AdvisoryDecision {
  const decision = clone(acceptedBuildHigh)
  decision.key = `bun-workspaces|https://github.com/advisories/GHSA-runtime|runtime-package|1.0.0|runtime-package`
  decision.advisory = { url: 'https://github.com/advisories/GHSA-runtime', title: 'runtime advisory', severity, vulnerableRange: '<2.0.0' }
  decision.instance = { source: 'bun-workspaces', packageName: 'runtime-package', version: '1.0.0', lockKey: 'runtime-package' }
  decision.automaticRole = 'runtime'
  decision.classification = 'runtime'
  decision.dependencyPaths = [['bun-workspaces:workspace:cli', 'bun-workspaces:runtime-package']]
  decision.rationale = 'The exact current runtime package advisory is time bounded while the same-major patch is verified.'
  decision.evidence = ['cli/package.json', 'bun test cli/src/runtime.test.ts']
  decision.expiresOn = severity === 'high' || severity === 'critical' ? '2026-08-15' : '2026-10-14'
  return decision
}

function evaluate(
  policy: AdvisoryPolicy,
  current: AffectedInstance[],
  baseline: AffectedInstance[] | undefined = current,
  asOf = '2026-07-16',
) {
  return evaluatePolicy({ policy, graphs: graphs(), current, baseline, asOf })
}

describe('dependency advisory policy', () => {
  it('accepts valid fixed, non-runtime high, runtime moderate, and current-only decisions', () => {
    const build = clone(acceptedBuildHigh)
    expect(evaluate(makePolicy([build]), [affectedFromDecision(build)]).ok).toBe(true)

    const fixed = clone(build)
    fixed.disposition = 'fixed'
    fixed.fixedTarget = 'vite@6.0.0'
    fixed.evidence = ['docs/package.json', 'bun test scripts/dependency-security/policy.test.ts']
    delete fixed.expiresOn
    expect(evaluate(makePolicy([fixed]), [], [affectedFromDecision(fixed)]).ok).toBe(true)

    const moderate = runtimeDecision('moderate')
    const moderateResult = evaluate(makePolicy([moderate]), [affectedFromDecision(moderate)])
    expect(moderateResult.ok).toBe(true)
    expect(moderateResult.summary.runtime).toEqual({ critical: 0, high: 0, moderate: 1, low: 0 })

    const currentOnly = runtimeDecision('moderate')
    currentOnly.baseline = false
    expect(evaluate(makePolicy([currentOnly]), [affectedFromDecision(currentOnly)], []).ok).toBe(true)

    const provenDowngrade = runtimeDecision('moderate')
    provenDowngrade.classification = 'build'
    provenDowngrade.rationale = 'The reported graph edge is not executable or shipped by the runtime entrypoint.'
    provenDowngrade.evidence = ['cli/src/runtime.ts', 'bun test cli/src/runtime.test.ts']
    expect(evaluate(makePolicy([provenDowngrade]), [affectedFromDecision(provenDowngrade)]).ok).toBe(true)

    const firstInstance = clone(acceptedBuildHigh)
    const secondInstance = clone(acceptedBuildHigh)
    secondInstance.instance.lockKey = 'other-parent/vite'
    secondInstance.key = secondInstance.key.replace('vitepress/vite', 'other-parent/vite')
    secondInstance.dependencyPaths = [['bun-workspaces:workspace:docs', 'bun-workspaces:other-parent/vite']]
    const expandedPolicy = makePolicy([firstInstance, secondInstance])
    expandedPolicy.baseline['bun-workspaces'].advisoryRows = 1
    expandedPolicy.baseline['bun-workspaces'].severity.high = 1
    expect(evaluate(
      expandedPolicy,
      [affectedFromDecision(firstInstance), affectedFromDecision(secondInstance)],
    ).ok).toBe(true)
  })

  it('accepts raw advisory totals that include duplicate rows collapsed by the policy identity', () => {
    const decision = clone(acceptedBuildHigh)
    const policy = makePolicy([decision])
    policy.baseline['bun-workspaces'].advisoryRows = 2
    policy.baseline['bun-workspaces'].severity.high = 2

    expect(evaluate(
      policy,
      [affectedFromDecision(decision)],
      [affectedFromDecision(decision)],
    ).ok).toBe(true)
  })

  it('reports every fail-closed advisory rule with a stable code', () => {
    const cases: Array<{
      name: string
      expected: string
      build: () => { policy: AdvisoryPolicy; current: AffectedInstance[]; baseline?: AffectedInstance[]; asOf?: string }
    }> = [
      {
        name: 'unknown current entry',
        expected: 'unknown-current-instance',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const unknown = clone(decision)
          unknown.key = unknown.key.replace('GHSA-build', 'GHSA-new')
          unknown.advisory.url = unknown.advisory.url.replace('GHSA-build', 'GHSA-new')
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision), affectedFromDecision(unknown)], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'stale current lock hash',
        expected: 'lock-hash-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.currentLocks['bun-workspaces'] = 'e'.repeat(64)
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'baseline key hash drift',
        expected: 'baseline-key-hash-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.baseline['bun-workspaces'].instanceKeysSha256 = 'e'.repeat(64)
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'baseline instance count drift',
        expected: 'baseline-instance-count-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.baseline['bun-workspaces'].instanceCount = 2
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'baseline raw advisory total drift',
        expected: 'baseline-advisory-row-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.baseline['bun-workspaces'].advisoryRows = 2
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'baseline severity drift',
        expected: 'baseline-severity-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.baseline['bun-workspaces'].severity.high = 0
          policy.baseline['bun-workspaces'].severity.critical = 1
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'current-only decision replaces baseline key',
        expected: 'baseline-flag-mismatch',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const baseline = affectedFromDecision(decision)
          decision.baseline = false
          return { policy: makePolicy([decision]), current: [baseline], baseline: [baseline] }
        },
      },
      {
        name: 'supplied baseline instance has no decision',
        expected: 'missing-baseline-instance',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          return { policy: makePolicy([]), current: [], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'dependency path drift',
        expected: 'dependency-path-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const current = affectedFromDecision(decision)
          current.dependencyPaths = [['bun-workspaces:workspace:docs', 'bun-workspaces:other-vite']]
          current.node.paths = clone(current.dependencyPaths)
          return { policy: makePolicy([decision]), current: [current], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'automatic role downgrade without source and command evidence',
        expected: 'invalid-role-downgrade',
        build: () => {
          const decision = runtimeDecision('moderate')
          decision.classification = 'build'
          decision.evidence = ['docs/package.json']
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'severity drift',
        expected: 'severity-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const current = affectedFromDecision(decision)
          current.advisory.severity = 'critical'
          return { policy: makePolicy([decision]), current: [current], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'advisory metadata drift',
        expected: 'advisory-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const current = affectedFromDecision(decision)
          current.advisory.title = 'changed advisory title'
          return { policy: makePolicy([decision]), current: [current], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'package instance drift',
        expected: 'instance-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const current = affectedFromDecision(decision)
          current.node.version = '5.4.22'
          return { policy: makePolicy([decision]), current: [current], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'automatic role drift',
        expected: 'automatic-role-drift',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const current = affectedFromDecision(decision)
          current.automaticRole = 'runtime'
          current.node.roles = ['runtime']
          return { policy: makePolicy([decision]), current: [current], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'fixed advisory reappears',
        expected: 'fixed-advisory-reappeared',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          decision.disposition = 'fixed'
          decision.fixedTarget = 'vite@6.0.0'
          delete decision.expiresOn
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'fixed entry lacks target and verification',
        expected: 'invalid-fixed-decision',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          decision.disposition = 'fixed'
          decision.evidence = []
          delete decision.expiresOn
          return { policy: makePolicy([decision]), current: [], baseline: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'runtime high accepted risk',
        expected: 'runtime-high-accepted-risk',
        build: () => {
          const decision = runtimeDecision('high')
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      },
      ...(['owner', 'rationale', 'evidence'] as const).map((field) => ({
        name: `missing ${field}`,
        expected: 'missing-decision-accountability',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          if (field === 'evidence') decision.evidence = []
          else decision[field] = ''
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      })),
      {
        name: 'expired accepted risk',
        expected: 'expired-accepted-risk',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)], asOf: '2026-08-16' }
        },
      },
      {
        name: 'future decision review',
        expected: 'future-decision-review',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          decision.reviewedOn = '2026-07-17'
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'decision review after policy capture',
        expected: 'future-decision-review',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.capturedOn = '2026-07-15'
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'future policy capture',
        expected: 'future-policy-capture',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.capturedOn = '2026-07-17'
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'overlong high exception',
        expected: 'overlong-accepted-risk',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          decision.expiresOn = '2026-08-16'
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'overlong moderate exception',
        expected: 'overlong-accepted-risk',
        build: () => {
          const decision = runtimeDecision('moderate')
          decision.expiresOn = '2026-10-15'
          return { policy: makePolicy([decision]), current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'override without compatibility evidence',
        expected: 'invalid-override',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.overrides = [{
            packageName: 'fast-uri',
            selectedVersion: '4.1.0',
            blockedBy: 'ajv@8.20.0 requires ^3.0.1',
            owner: 'hapi-maintainers',
            rationale: 'Temporary compatible selection until the parent range is released.',
            evidence: [],
            reviewedOn: '2026-07-16',
            expiresOn: '2026-08-15',
          }]
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'expired override',
        expected: 'expired-override',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.overrides = [{
            packageName: 'fast-uri',
            selectedVersion: '4.1.0',
            blockedBy: 'ajv@8.20.0 requires ^3.0.1',
            owner: 'hapi-maintainers',
            rationale: 'Temporary compatible selection until the parent range is released.',
            evidence: ['scripts/dependency-security/policy.test.ts', 'bun test scripts/dependency-security/policy.test.ts'],
            reviewedOn: '2026-07-16',
            expiresOn: '2026-08-15',
          }]
          return { policy, current: [affectedFromDecision(decision)], asOf: '2026-08-16' }
        },
      },
      {
        name: 'future override review',
        expected: 'future-override-review',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.overrides = [{
            packageName: 'fast-uri',
            selectedVersion: '4.1.0',
            blockedBy: 'ajv@8.20.0 requires ^3.0.1',
            owner: 'hapi-maintainers',
            rationale: 'Temporary compatible selection until the parent range is released.',
            evidence: ['scripts/dependency-security/policy.test.ts', 'bun test scripts/dependency-security/policy.test.ts'],
            reviewedOn: '2026-07-17',
            expiresOn: '2026-08-16',
          }]
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
      {
        name: 'overlong override',
        expected: 'overlong-override',
        build: () => {
          const decision = clone(acceptedBuildHigh)
          const policy = makePolicy([decision])
          policy.overrides = [{
            packageName: 'fast-uri',
            selectedVersion: '4.1.0',
            blockedBy: 'ajv@8.20.0 requires ^3.0.1',
            owner: 'hapi-maintainers',
            rationale: 'Temporary compatible selection until the parent range is released.',
            evidence: ['scripts/dependency-security/policy.test.ts', 'bun test scripts/dependency-security/policy.test.ts'],
            reviewedOn: '2026-07-16',
            expiresOn: '2026-08-16',
          }]
          return { policy, current: [affectedFromDecision(decision)] }
        },
      },
    ]

    for (const testCase of cases) {
      const args = testCase.build()
      const result = evaluate(args.policy, args.current, args.baseline, args.asOf)
      expect(result.violations.map((entry) => entry.code), testCase.name).toContain(testCase.expected)
      expect(result.violations, `${testCase.name} violation order`).toEqual(
        [...result.violations].sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key) || a.message.localeCompare(b.message)),
      )
    }
  })

  it('rejects unknown fields, duplicate keys, and non-exact calendar dates', () => {
    const valid = makePolicy()
    expect(parsePolicy(clone(valid))).toEqual(valid)

    const unknowns: Array<[string, (value: Record<string, any>) => void]> = [
      ['top level', (value) => { value.unknown = true }],
      ['package manager', (value) => { value.packageManagers.unknown = 'x' }],
      ['baseline header', (value) => { value.baseline['bun-workspaces'].unknown = true }],
      ['severity header', (value) => { value.baseline['bun-workspaces'].severity.info = 0 }],
      ['current locks', (value) => { value.currentLocks.unknown = 'x' }],
      ['decision', (value) => { value.decisions[0].unknown = true }],
      ['decision advisory', (value) => { value.decisions[0].advisory.unknown = true }],
      ['decision instance', (value) => { value.decisions[0].instance.unknown = true }],
      ['override', (value) => {
        value.overrides = [{
          packageName: 'fast-uri', selectedVersion: '4.1.0', blockedBy: 'ajv ^3',
          owner: 'owner', rationale: 'reason', evidence: ['test'], reviewedOn: '2026-07-16', expiresOn: '2026-08-15', unknown: true,
        }]
      }],
    ]
    for (const [name, mutate] of unknowns) {
      const value = clone(valid) as unknown as Record<string, any>
      mutate(value)
      expect(() => parsePolicy(value), name).toThrow(/unknown field/i)
    }

    const duplicate = clone(valid)
    duplicate.decisions.push(clone(duplicate.decisions[0]))
    expect(() => parsePolicy(duplicate)).toThrow(/duplicate decision key/i)

    for (const capturedOn of ['2026-7-16', '2026-02-30', '2026-07-16T00:00:00Z']) {
      const invalid = clone(valid)
      invalid.capturedOn = capturedOn
      expect(() => parsePolicy(invalid)).toThrow(/YYYY-MM-DD|calendar date/i)
    }
  })
})
