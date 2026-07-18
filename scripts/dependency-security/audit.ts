import type {
  Advisory,
  AffectedInstance,
  AuditCapture,
  DependencyGraph,
  DependencyRole,
  Severity,
} from './model'
import { roleImpact } from './lockGraph'

type UnknownRecord = Record<string, unknown>

export type AuditCommandResult = {
  command: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
}
export type AuditCommandRunner = (command: string[], cwd: string) => Promise<AuditCommandResult>

export class OperationalAuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OperationalAuditError'
  }
}

const SEVERITIES = new Set<Severity>(['critical', 'high', 'moderate', 'low'])
const NPM_METADATA_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const
const RANGE_VERSION = String.raw`v?(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`
const RANGE_TOKEN = new RegExp(`^(?:<=|>=|<|>|=|~|\\^)?${RANGE_VERSION}$`)
const HYPHEN_RANGE = new RegExp(`^${RANGE_VERSION}\\s+-\\s+${RANGE_VERSION}$`)

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new OperationalAuditError(`${label} must be an object`)
  }
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperationalAuditError(`${label} must be a non-empty string`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return text(value, label)
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OperationalAuditError(`${label} must be a nonnegative safe integer`)
  }
  return value as number
}

function severity(value: unknown, label: string): Severity {
  if (typeof value !== 'string' || !SEVERITIES.has(value as Severity)) {
    throw new OperationalAuditError(`${label} has unsupported severity ${String(value)}`)
  }
  return value as Severity
}

function parseJson(stdout: string, label: string): unknown {
  if (stdout.trim().length === 0) {
    throw new OperationalAuditError(`${label} returned empty output`)
  }
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new OperationalAuditError(`${label} returned invalid JSON`, { cause: error })
  }
}

function compareAdvisories(a: Advisory, b: Advisory): number {
  return a.packageName.localeCompare(b.packageName)
    || a.url.localeCompare(b.url)
    || a.vulnerableRange.localeCompare(b.vulnerableRange)
    || a.id.localeCompare(b.id)
}

function concreteNpmAdvisory(value: unknown, label: string): Advisory {
  const item = record(value, label)
  return {
    source: 'hapi-codex-sync',
    id: identifier(item.source, `${label}.source`),
    url: text(item.url, `${label}.url`),
    title: text(item.title, `${label}.title`),
    severity: severity(item.severity, `${label}.severity`),
    vulnerableRange: text(item.range, `${label}.range`),
    packageName: text(item.name, `${label}.name`),
  }
}

export function parseBunAudit(stdout: string): Advisory[] {
  const root = record(parseJson(stdout, 'bun audit'), 'bun audit result')
  const advisories: Advisory[] = []
  for (const [packageName, rawEntries] of Object.entries(root)) {
    if (packageName.length === 0 || !Array.isArray(rawEntries) || rawEntries.length === 0) {
      throw new OperationalAuditError(`bun audit package ${packageName || '<empty>'} must contain advisories`)
    }
    rawEntries.forEach((rawEntry, index) => {
      const entry = record(rawEntry, `bun audit ${packageName}[${index}]`)
      advisories.push({
        source: 'bun-workspaces',
        id: identifier(entry.id, `bun audit ${packageName}[${index}].id`),
        url: text(entry.url, `bun audit ${packageName}[${index}].url`),
        title: text(entry.title, `bun audit ${packageName}[${index}].title`),
        severity: severity(entry.severity, `bun audit ${packageName}[${index}].severity`),
        vulnerableRange: text(entry.vulnerable_versions, `bun audit ${packageName}[${index}].vulnerable_versions`),
        packageName,
      })
    })
  }
  return advisories.sort(compareAdvisories)
}

export function parseNpmAudit(stdout: string): Advisory[] {
  const root = record(parseJson(stdout, 'npm audit'), 'npm audit result')
  if (root.auditReportVersion !== 2) {
    throw new OperationalAuditError(`unsupported npm auditReportVersion ${String(root.auditReportVersion)}`)
  }
  const vulnerabilities = record(root.vulnerabilities, 'npm audit vulnerabilities')
  const metadata = record(root.metadata, 'npm audit metadata')
  const metadataVulnerabilities = record(
    metadata.vulnerabilities,
    'npm audit metadata.vulnerabilities',
  )
  const expectedMetadataKeys = [...NPM_METADATA_SEVERITIES, 'total'].sort()
  const actualMetadataKeys = Object.keys(metadataVulnerabilities).sort()
  if (
    actualMetadataKeys.length !== expectedMetadataKeys.length
    || actualMetadataKeys.some((key, index) => key !== expectedMetadataKeys[index])
  ) {
    throw new OperationalAuditError('npm audit metadata.vulnerabilities has unsupported counters')
  }
  const metadataCounts = Object.fromEntries(
    NPM_METADATA_SEVERITIES.map((name) => [
      name,
      nonnegativeInteger(
        metadataVulnerabilities[name],
        `npm audit metadata.vulnerabilities.${name}`,
      ),
    ]),
  ) as Record<(typeof NPM_METADATA_SEVERITIES)[number], number>
  const metadataTotal = nonnegativeInteger(
    metadataVulnerabilities.total,
    'npm audit metadata.vulnerabilities.total',
  )
  const summedMetadataTotal = NPM_METADATA_SEVERITIES.reduce(
    (total, name) => total + metadataCounts[name],
    0,
  )
  if (metadataTotal !== summedMetadataTotal) {
    throw new OperationalAuditError('npm audit metadata vulnerability counters do not sum to total')
  }
  if (metadataTotal !== Object.keys(vulnerabilities).length) {
    throw new OperationalAuditError('npm audit metadata total does not match vulnerability entries')
  }
  const observedCounts = Object.fromEntries(
    NPM_METADATA_SEVERITIES.map((name) => [name, 0]),
  ) as Record<(typeof NPM_METADATA_SEVERITIES)[number], number>
  for (const [name, rawVulnerability] of Object.entries(vulnerabilities)) {
    const vulnerability = record(rawVulnerability, `npm audit vulnerability ${name}`)
    if (
      typeof vulnerability.severity !== 'string'
      || !NPM_METADATA_SEVERITIES.includes(
        vulnerability.severity as (typeof NPM_METADATA_SEVERITIES)[number],
      )
    ) {
      throw new OperationalAuditError(`npm audit vulnerability ${name} has unsupported severity`)
    }
    observedCounts[vulnerability.severity as (typeof NPM_METADATA_SEVERITIES)[number]] += 1
  }
  for (const name of NPM_METADATA_SEVERITIES) {
    if (observedCounts[name] !== metadataCounts[name]) {
      throw new OperationalAuditError(`npm audit metadata ${name} count does not match vulnerability entries`)
    }
  }
  const cache = new Map<string, Advisory[]>()

  const resolveConcrete = (name: string, stack: string[]): Advisory[] => {
    const cached = cache.get(name)
    if (cached) return cached
    if (stack.includes(name)) {
      throw new OperationalAuditError(`npm audit aggregate cycle: ${[...stack, name].join(' -> ')}`)
    }
    const vulnerability = record(vulnerabilities[name], `npm audit vulnerability ${name}`)
    if (vulnerability.name !== name) {
      throw new OperationalAuditError(`npm audit vulnerability name mismatch for ${name}`)
    }
    if (!Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
      throw new OperationalAuditError(`npm audit vulnerability ${name} has no concrete advisory`)
    }

    const concrete: Advisory[] = []
    vulnerability.via.forEach((via, index) => {
      if (typeof via === 'string') {
        if (via.length === 0) {
          throw new OperationalAuditError(`npm audit vulnerability ${name} has an empty aggregate`)
        }
        concrete.push(...resolveConcrete(via, [...stack, name]))
      } else {
        concrete.push(concreteNpmAdvisory(via, `npm audit ${name}.via[${index}]`))
      }
    })
    if (concrete.length === 0) {
      throw new OperationalAuditError(`npm audit vulnerability ${name} has no concrete advisory`)
    }
    cache.set(name, concrete)
    return concrete
  }

  const unique = new Map<string, Advisory>()
  for (const name of Object.keys(vulnerabilities).sort()) {
    for (const advisory of resolveConcrete(name, [])) {
      const key = [
        advisory.source,
        advisory.id,
        advisory.url,
        advisory.packageName,
        advisory.vulnerableRange,
        advisory.severity,
      ].join('\0')
      unique.set(key, advisory)
    }
  }
  return [...unique.values()].sort(compareAdvisories)
}

async function defaultRunner(command: string[], cwd: string): Promise<AuditCommandResult> {
  const subprocess = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return { command, cwd, exitCode, stdout, stderr }
}

export async function captureAudit(
  manager: 'bun' | 'npm',
  cwd: string,
  runner: AuditCommandRunner = defaultRunner,
): Promise<AuditCapture> {
  const command = manager === 'bun'
    ? ['bun', 'audit', '--json', '--production']
    : ['npm', 'audit', '--omit=dev', '--json']
  let result: AuditCommandResult
  try {
    result = await runner(command, cwd)
  } catch (error) {
    throw new OperationalAuditError(`${manager} audit command could not run`, { cause: error })
  }
  if (
    !Array.isArray(result.command)
    || result.command.some((part) => typeof part !== 'string')
    || typeof result.cwd !== 'string'
    || !Number.isInteger(result.exitCode)
    || typeof result.stdout !== 'string'
    || typeof result.stderr !== 'string'
  ) {
    throw new OperationalAuditError(`${manager} audit runner returned a malformed result`)
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new OperationalAuditError(`${manager} audit failed operationally with exit ${result.exitCode}`)
  }

  let advisories: Advisory[]
  try {
    advisories = manager === 'bun' ? parseBunAudit(result.stdout) : parseNpmAudit(result.stdout)
  } catch (error) {
    if (error instanceof OperationalAuditError) throw error
    throw new OperationalAuditError(`${manager} audit output could not be normalized`, { cause: error })
  }
  if (result.exitCode === 0 && advisories.length !== 0) {
    throw new OperationalAuditError(`${manager} audit exit zero contained advisories`)
  }
  if (result.exitCode === 1 && advisories.length === 0) {
    throw new OperationalAuditError(`${manager} audit exit one contained no advisories`)
  }

  return {
    manager,
    command: [...result.command],
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    advisories,
  }
}

function validateRange(range: string): void {
  if (range !== range.trim() || range.length === 0 || /[\u0000-\u001f\u007f]/.test(range)) {
    throw new OperationalAuditError(`invalid vulnerable range ${JSON.stringify(range)}`)
  }
  const clauses = range.split('||').map((clause) => clause.trim())
  if (clauses.some((clause) => clause.length === 0)) {
    throw new OperationalAuditError(`invalid vulnerable range ${JSON.stringify(range)}`)
  }
  for (const clause of clauses) {
    if (HYPHEN_RANGE.test(clause)) continue
    const tokens = clause.split(/\s+/)
    if (tokens.some((token) => !RANGE_TOKEN.test(token))) {
      throw new OperationalAuditError(`invalid vulnerable range ${JSON.stringify(range)}`)
    }
  }
}

function highestRole(roles: DependencyRole[]): DependencyRole {
  if (roles.length === 0) {
    throw new OperationalAuditError('affected package node has no dependency role')
  }
  return [...roles].sort((a, b) => roleImpact(b) - roleImpact(a))[0]
}

function normalizedPaths(nodeRef: string, paths: string[][]): string[][] {
  if (paths.length === 0) {
    throw new OperationalAuditError(`affected package node ${nodeRef} has no dependency path`)
  }
  const unique = new Map<string, string[]>()
  for (const path of paths) {
    if (path.length < 2 || path.at(-1) !== nodeRef || !path[0].includes(':workspace:')) {
      throw new OperationalAuditError(`affected package node ${nodeRef} has a malformed dependency path`)
    }
    unique.set(path.join('\0'), [...path])
  }
  return [...unique.values()].sort((a, b) => a.join('\0').localeCompare(b.join('\0')))
}

export function matchAffectedInstances(graph: DependencyGraph, advisories: Advisory[]): AffectedInstance[] {
  const affected = new Map<string, AffectedInstance>()
  for (const advisory of advisories) {
    if (advisory.source !== graph.source) {
      throw new OperationalAuditError(`advisory source ${advisory.source} does not match graph ${graph.source}`)
    }
    validateRange(advisory.vulnerableRange)
    let matched = 0
    for (const node of graph.nodes) {
      if (node.name !== advisory.packageName) continue
      let vulnerable: boolean
      try {
        vulnerable = Bun.semver.satisfies(node.version, advisory.vulnerableRange)
      } catch (error) {
        throw new OperationalAuditError(`could not evaluate vulnerable range ${advisory.vulnerableRange}`, { cause: error })
      }
      if (!vulnerable) continue
      matched += 1
      const dependencyPaths = normalizedPaths(node.ref, node.paths)
      const instance: AffectedInstance = {
        key: `${graph.source}|${advisory.url}|${advisory.packageName}|${node.version}|${node.lockKey}`,
        advisory,
        node,
        automaticRole: highestRole(node.roles),
        dependencyPaths,
      }
      const existing = affected.get(instance.key)
      if (existing && JSON.stringify(existing) !== JSON.stringify(instance)) {
        throw new OperationalAuditError(`conflicting affected instance key ${instance.key}`)
      }
      affected.set(instance.key, instance)
    }
    if (matched === 0) {
      throw new OperationalAuditError(`advisory ${advisory.url} has no affected installed instance`)
    }
  }
  return [...affected.values()].sort((a, b) => a.key.localeCompare(b.key))
}
