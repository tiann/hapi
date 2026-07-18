import { describe, expect, it } from 'bun:test'
import type { DependencyGraph, PackageNode } from './model'
import {
  captureAudit,
  matchAffectedInstances,
  OperationalAuditError,
  parseBunAudit,
  parseNpmAudit,
  type AuditCommandRunner,
} from './audit'

const validExitOne: AuditCommandRunner = async () => ({
  command: ['bun', 'audit', '--json', '--production'],
  cwd: '/repo',
  exitCode: 1,
  stdout: '{"ws":[{"id":1,"url":"https://github.com/advisories/GHSA-test","title":"test","severity":"high","vulnerable_versions":"<8.21.0"}]}',
  stderr: '',
})

function node(lockKey: string, version: string, roles: PackageNode['roles'], paths: string[][]): PackageNode {
  return {
    ref: `bun-workspaces:${lockKey}`,
    lockSource: 'bun-workspaces',
    lockKey,
    name: 'duplicate',
    version,
    integrity: 'sha512-Zml4dHVyZQ==',
    purl: `pkg:npm/duplicate@${version}`,
    platform: null,
    roles,
    paths,
  }
}

function duplicateGraph(): DependencyGraph {
  return {
    source: 'bun-workspaces',
    lockPath: '/repo/bun.lock',
    lockSha256: 'a'.repeat(64),
    roots: [],
    nodes: [
      node('duplicate', '1.5.0', ['development'], [['bun-workspaces:workspace:.', 'bun-workspaces:duplicate']]),
      node('parent/duplicate', '1.5.0', ['runtime', 'development'], [['bun-workspaces:workspace:cli', 'bun-workspaces:parent', 'bun-workspaces:parent/duplicate']]),
      node('other-parent/duplicate', '2.1.0', ['build'], [['bun-workspaces:workspace:docs', 'bun-workspaces:other-parent', 'bun-workspaces:other-parent/duplicate']]),
    ],
    edges: [],
  }
}

describe('dependency audit normalization', () => {
  it('normalizes Bun package arrays and npm concrete and aggregate via entries', async () => {
    const bun = parseBunAudit(await Bun.file('scripts/dependency-security/fixtures/bun-audit.json').text())
    expect(bun.map((entry) => [entry.source, entry.packageName, entry.id, entry.severity, entry.vulnerableRange])).toEqual([
      ['bun-workspaces', 'duplicate', '1001', 'high', '<2.0.0'],
      ['bun-workspaces', 'duplicate', '1002', 'moderate', '>=2.0.0 <3.0.0'],
      ['bun-workspaces', 'other', '1003', 'low', '<=1.0.0'],
    ])

    const npm = parseNpmAudit(await Bun.file('scripts/dependency-security/fixtures/npm-audit.json').text())
    expect(npm.map((entry) => [entry.source, entry.packageName, entry.id, entry.url])).toEqual([
      ['hapi-codex-sync', 'direct-leaf', '2002', 'https://github.com/advisories/GHSA-direct-leaf'],
      ['hapi-codex-sync', 'vulnerable-leaf', '2001', 'https://github.com/advisories/GHSA-vulnerable-leaf'],
    ])
  })

  it('accepts advisory exit one only with valid manager JSON', async () => {
    const capture = await captureAudit('bun', '/repo', validExitOne)
    expect(capture.exitCode).toBe(1)
    expect(capture.advisories).toHaveLength(1)
  })

  it('accepts clean exit zero for both manager schemas', async () => {
    const bun = await captureAudit('bun', '/repo', async () => ({
      command: ['bun', 'audit', '--json', '--production'],
      cwd: '/repo',
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    }))
    expect(bun.advisories).toEqual([])

    const npm = await captureAudit('npm', '/repo', async () => ({
      command: ['npm', 'audit', '--omit=dev', '--json'],
      cwd: '/repo',
      exitCode: 0,
      stdout: '{"auditReportVersion":2,"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}',
      stderr: '',
    }))
    expect(npm.advisories).toEqual([])
  })

  it('fails closed on missing, malformed, or contradictory npm vulnerability metadata', () => {
    for (const output of [
      { auditReportVersion: 2, vulnerabilities: {} },
      {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
      },
      {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 } },
      },
      {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: -1 } },
      },
      {
        auditReportVersion: 2,
        vulnerabilities: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0.5, critical: 0, total: 0.5 } },
      },
      {
        auditReportVersion: 2,
        vulnerabilities: {
          package: {
            name: 'package',
            severity: 'high',
            via: [{
              source: 1,
              name: 'package',
              title: 'test',
              url: 'https://github.com/advisories/GHSA-test',
              severity: 'high',
              range: '<2.0.0',
            }],
          },
        },
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
      },
    ]) {
      expect(() => parseNpmAudit(JSON.stringify(output))).toThrow(OperationalAuditError)
    }
  })

  it('treats invalid advisory output as an operational error', async () => {
    await expect(captureAudit('bun', '/repo', async () => ({
      command: ['bun', 'audit'], cwd: '/repo', exitCode: 1, stdout: '', stderr: 'network failed',
    }))).rejects.toThrow(OperationalAuditError)

    for (const result of [
      { exitCode: 0, stdout: 'not-json', stderr: '' },
      { exitCode: 1, stdout: '{}', stderr: 'empty advisory result' },
      { exitCode: 2, stdout: '{}', stderr: 'manager failure' },
    ]) {
      await expect(captureAudit('bun', '/repo', async () => ({
        command: ['bun', 'audit'], cwd: '/repo', ...result,
      }))).rejects.toThrow(OperationalAuditError)
    }
  })

  it('fails closed when an npm aggregate has no concrete advisory', () => {
    expect(() => parseNpmAudit('{"auditReportVersion":2,"vulnerabilities":{"aggregate":{"name":"aggregate","severity":"high","via":["missing"],"nodes":[]}},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":1,"critical":0,"total":1}}}'))
      .toThrow(OperationalAuditError)
  })

  it('matches every vulnerable installed instance with Bun semver and highest role', () => {
    const advisories = parseBunAudit('{"duplicate":[{"id":1,"url":"https://github.com/advisories/GHSA-match","title":"match","severity":"high","vulnerable_versions":">=1.0.0 <2.0.0"}]}')
    const affected = matchAffectedInstances(duplicateGraph(), advisories)
    expect(affected.map((entry) => [entry.node.lockKey, entry.node.version, entry.automaticRole])).toEqual([
      ['duplicate', '1.5.0', 'development'],
      ['parent/duplicate', '1.5.0', 'runtime'],
    ])
    expect(affected.map((entry) => entry.key)).toEqual([
      'bun-workspaces|https://github.com/advisories/GHSA-match|duplicate|1.5.0|duplicate',
      'bun-workspaces|https://github.com/advisories/GHSA-match|duplicate|1.5.0|parent/duplicate',
    ])
  })

  it('fails closed on invalid ranges, missing paths, and unmatched advisories', () => {
    const graph = duplicateGraph()
    const advisory = parseBunAudit('{"duplicate":[{"id":1,"url":"https://github.com/advisories/GHSA-match","title":"match","severity":"high","vulnerable_versions":"<2.0.0"}]}')[0]
    expect(() => matchAffectedInstances(graph, [{ ...advisory, vulnerableRange: 'not a range' }])).toThrow(OperationalAuditError)
    expect(() => matchAffectedInstances(graph, [{ ...advisory, packageName: 'absent' }])).toThrow(OperationalAuditError)
    graph.nodes[0].paths = []
    expect(() => matchAffectedInstances(graph, [advisory])).toThrow(OperationalAuditError)
  })
})
