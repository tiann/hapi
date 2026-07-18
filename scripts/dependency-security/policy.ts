import { createHash } from 'node:crypto'
import type {
  AdvisoryDecision,
  AdvisoryPolicy,
  AffectedInstance,
  DependencyGraph,
  DependencyRole,
  GateResult,
  LockSourceId,
  PolicyViolation,
  Severity,
} from './model'
import { LOCK_SOURCE_IDS } from './model'
import { roleImpact } from './lockGraph'

type UnknownRecord = Record<string, unknown>
type OverrideRecord = AdvisoryPolicy['overrides'][number]

const ROLES = new Set<DependencyRole>(['runtime', 'build', 'development', 'not-applicable'])
const SEVERITIES = new Set<Severity>(['critical', 'high', 'moderate', 'low'])
const SHA256 = /^[a-f0-9]{64}$/
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SOURCE_EVIDENCE = /^(?:package\.json|bun\.lock|(?:cli|hub|web|website|docs|shared|scripts|tools)\/\S+)$/
const COMMAND_EVIDENCE = /^(?:bun|npm|node|git|sh|bash)\s+\S+|(?:^|\/)\S+\.test\.[A-Za-z0-9]+$/
const NON_EXECUTABLE_RATIONALE = /\b(?:not executable|not executed|not shipped|not started|cannot execute|unreachable)\b/i

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value: UnknownRecord, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field ${label}.${key}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`missing field ${label}.${key}`)
  }
}

function string(value: unknown, label: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? 'a non-empty ' : 'a '}string`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function sha(value: unknown, label: string): string {
  const parsed = string(value, label, true)
  if (!SHA256.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`)
  return parsed
}

function date(value: unknown, label: string): string {
  const parsed = string(value, label, true)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new Error(`${label} must use exact YYYY-MM-DD`)
  const instant = new Date(`${parsed}T00:00:00.000Z`)
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== parsed) {
    throw new Error(`${label} must be a real calendar date`)
  }
  return parsed
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return [...value]
}

function role(value: unknown, label: string): DependencyRole {
  if (typeof value !== 'string' || !ROLES.has(value as DependencyRole)) throw new Error(`${label} has an invalid role`)
  return value as DependencyRole
}

function severity(value: unknown, label: string): Severity {
  if (typeof value !== 'string' || !SEVERITIES.has(value as Severity)) throw new Error(`${label} has an invalid severity`)
  return value as Severity
}

function source(value: unknown, label: string): LockSourceId {
  if (typeof value !== 'string' || !LOCK_SOURCE_IDS.includes(value as LockSourceId)) throw new Error(`${label} has an invalid lock source`)
  return value as LockSourceId
}

function paths(value: unknown, label: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => strings(entry, `${label}[${index}]`))
}

function parseSeverityRecord(value: unknown, label: string): Record<Severity, number> {
  const parsed = object(value, label)
  exactKeys(parsed, ['critical', 'high', 'moderate', 'low'], [], label)
  return {
    critical: integer(parsed.critical, `${label}.critical`),
    high: integer(parsed.high, `${label}.high`),
    moderate: integer(parsed.moderate, `${label}.moderate`),
    low: integer(parsed.low, `${label}.low`),
  }
}

function parseBaselineHeader(value: unknown, label: string): AdvisoryPolicy['baseline'][LockSourceId] {
  const parsed = object(value, label)
  exactKeys(parsed, ['lockSha256', 'auditSha256', 'advisoryRows', 'instanceCount', 'instanceKeysSha256', 'severity'], [], label)
  return {
    lockSha256: sha(parsed.lockSha256, `${label}.lockSha256`),
    auditSha256: sha(parsed.auditSha256, `${label}.auditSha256`),
    advisoryRows: integer(parsed.advisoryRows, `${label}.advisoryRows`),
    instanceCount: integer(parsed.instanceCount, `${label}.instanceCount`),
    instanceKeysSha256: sha(parsed.instanceKeysSha256, `${label}.instanceKeysSha256`),
    severity: parseSeverityRecord(parsed.severity, `${label}.severity`),
  }
}

function parseDecision(value: unknown, index: number): AdvisoryDecision {
  const label = `policy.decisions[${index}]`
  const parsed = object(value, label)
  exactKeys(
    parsed,
    ['key', 'baseline', 'advisory', 'instance', 'automaticRole', 'classification', 'dependencyPaths', 'disposition', 'owner', 'rationale', 'evidence', 'reviewedOn'],
    ['expiresOn', 'fixedTarget'],
    label,
  )
  const advisory = object(parsed.advisory, `${label}.advisory`)
  exactKeys(advisory, ['url', 'title', 'severity', 'vulnerableRange'], [], `${label}.advisory`)
  const instance = object(parsed.instance, `${label}.instance`)
  exactKeys(instance, ['source', 'packageName', 'version', 'lockKey'], [], `${label}.instance`)
  if (parsed.disposition !== 'fixed' && parsed.disposition !== 'accepted-risk') {
    throw new Error(`${label}.disposition is invalid`)
  }
  return {
    key: string(parsed.key, `${label}.key`, true),
    baseline: boolean(parsed.baseline, `${label}.baseline`),
    advisory: {
      url: string(advisory.url, `${label}.advisory.url`, true),
      title: string(advisory.title, `${label}.advisory.title`),
      severity: severity(advisory.severity, `${label}.advisory.severity`),
      vulnerableRange: string(advisory.vulnerableRange, `${label}.advisory.vulnerableRange`, true),
    },
    instance: {
      source: source(instance.source, `${label}.instance.source`),
      packageName: string(instance.packageName, `${label}.instance.packageName`, true),
      version: string(instance.version, `${label}.instance.version`, true),
      lockKey: string(instance.lockKey, `${label}.instance.lockKey`, true),
    },
    automaticRole: role(parsed.automaticRole, `${label}.automaticRole`),
    classification: role(parsed.classification, `${label}.classification`),
    dependencyPaths: paths(parsed.dependencyPaths, `${label}.dependencyPaths`),
    disposition: parsed.disposition,
    owner: string(parsed.owner, `${label}.owner`),
    rationale: string(parsed.rationale, `${label}.rationale`),
    evidence: strings(parsed.evidence, `${label}.evidence`),
    reviewedOn: date(parsed.reviewedOn, `${label}.reviewedOn`),
    ...(parsed.expiresOn === undefined ? {} : { expiresOn: date(parsed.expiresOn, `${label}.expiresOn`) }),
    ...(parsed.fixedTarget === undefined ? {} : { fixedTarget: string(parsed.fixedTarget, `${label}.fixedTarget`) }),
  }
}

function parseOverride(value: unknown, index: number): OverrideRecord {
  const label = `policy.overrides[${index}]`
  const parsed = object(value, label)
  exactKeys(parsed, ['packageName', 'selectedVersion', 'blockedBy', 'owner', 'rationale', 'evidence', 'reviewedOn', 'expiresOn'], [], label)
  return {
    packageName: string(parsed.packageName, `${label}.packageName`),
    selectedVersion: string(parsed.selectedVersion, `${label}.selectedVersion`),
    blockedBy: string(parsed.blockedBy, `${label}.blockedBy`),
    owner: string(parsed.owner, `${label}.owner`),
    rationale: string(parsed.rationale, `${label}.rationale`),
    evidence: strings(parsed.evidence, `${label}.evidence`),
    reviewedOn: date(parsed.reviewedOn, `${label}.reviewedOn`),
    expiresOn: date(parsed.expiresOn, `${label}.expiresOn`),
  }
}

export function parsePolicy(value: unknown): AdvisoryPolicy {
  const parsed = object(value, 'policy')
  exactKeys(parsed, ['schemaVersion', 'capturedOn', 'packageManagers', 'baseline', 'currentLocks', 'decisions', 'overrides'], [], 'policy')
  if (parsed.schemaVersion !== 1) throw new Error('policy.schemaVersion must equal 1')
  const managers = object(parsed.packageManagers, 'policy.packageManagers')
  exactKeys(managers, ['bun', 'npm'], [], 'policy.packageManagers')
  const baseline = object(parsed.baseline, 'policy.baseline')
  exactKeys(baseline, [...LOCK_SOURCE_IDS], [], 'policy.baseline')
  const currentLocks = object(parsed.currentLocks, 'policy.currentLocks')
  exactKeys(currentLocks, [...LOCK_SOURCE_IDS], [], 'policy.currentLocks')
  if (!Array.isArray(parsed.decisions)) throw new Error('policy.decisions must be an array')
  if (!Array.isArray(parsed.overrides)) throw new Error('policy.overrides must be an array')

  const decisions = parsed.decisions.map(parseDecision)
  const decisionKeys = new Set<string>()
  for (const decision of decisions) {
    if (decisionKeys.has(decision.key)) throw new Error(`duplicate decision key ${decision.key}`)
    decisionKeys.add(decision.key)
  }
  const overrides = parsed.overrides.map(parseOverride)
  const overrideNames = new Set<string>()
  for (const item of overrides) {
    if (overrideNames.has(item.packageName)) throw new Error(`duplicate override package ${item.packageName}`)
    overrideNames.add(item.packageName)
  }

  return {
    schemaVersion: 1,
    capturedOn: date(parsed.capturedOn, 'policy.capturedOn'),
    packageManagers: {
      bun: string(managers.bun, 'policy.packageManagers.bun', true),
      npm: string(managers.npm, 'policy.packageManagers.npm', true),
    },
    baseline: {
      'bun-workspaces': parseBaselineHeader(baseline['bun-workspaces'], 'policy.baseline.bun-workspaces'),
      'hapi-codex-sync': parseBaselineHeader(baseline['hapi-codex-sync'], 'policy.baseline.hapi-codex-sync'),
    },
    currentLocks: {
      'bun-workspaces': sha(currentLocks['bun-workspaces'], 'policy.currentLocks.bun-workspaces'),
      'hapi-codex-sync': sha(currentLocks['hapi-codex-sync'], 'policy.currentLocks.hapi-codex-sync'),
    },
    decisions,
    overrides,
  }
}

function utcDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000
}

function keyHash(keys: string[]): string {
  const sorted = [...keys].sort()
  const payload = sorted.length === 0 ? '' : `${sorted.join('\n')}\n`
  return createHash('sha256').update(payload).digest('hex')
}

function severityCounts(items: Array<{ advisory: { severity: Severity } }>): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const item of items) counts[item.advisory.severity] += 1
  return counts
}

type AdvisoryRowLike = {
  advisory: { url: string; severity: Severity }
  node?: { name: string }
  instance?: { packageName: string }
}

function advisoryIdentity(item: AdvisoryRowLike): string {
  return `${item.advisory.url}\0${item.node?.name ?? item.instance?.packageName ?? ''}`
}

function advisoryRows(items: AdvisoryRowLike[]): number {
  return new Set(items.map(advisoryIdentity)).size
}

function advisorySeverityCounts(items: AdvisoryRowLike[]): {
  counts: Record<Severity, number>
  conflicts: string[]
} {
  const rows = new Map<string, Severity>()
  const conflicts = new Set<string>()
  for (const item of items) {
    const key = advisoryIdentity(item)
    const existing = rows.get(key)
    if (existing !== undefined && existing !== item.advisory.severity) conflicts.add(key)
    else rows.set(key, item.advisory.severity)
  }
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const value of rows.values()) counts[value] += 1
  return { counts, conflicts: [...conflicts].sort() }
}

function samePaths(left: string[][], right: string[][]): boolean {
  const normalize = (value: string[][]) => value.map((path) => path.join('\0')).sort()
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function expectedDecisionKey(decision: AdvisoryDecision): string {
  return `${decision.instance.source}|${decision.advisory.url}|${decision.instance.packageName}|${decision.instance.version}|${decision.instance.lockKey}`
}

function hasAccountability(decision: AdvisoryDecision): boolean {
  return decision.owner.trim().length > 0
    && decision.rationale.trim().length > 0
    && decision.evidence.length > 0
    && decision.evidence.every((entry) => entry.trim().length > 0)
}

function hasVerificationEvidence(evidence: string[]): boolean {
  return evidence.some((entry) => COMMAND_EVIDENCE.test(entry))
}

function hasDowngradeEvidence(decision: AdvisoryDecision): boolean {
  return decision.evidence.some((entry) => SOURCE_EVIDENCE.test(entry))
    && hasVerificationEvidence(decision.evidence)
    && NON_EXECUTABLE_RATIONALE.test(decision.rationale)
}

function sortViolations(violations: PolicyViolation[]): PolicyViolation[] {
  return violations.sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key) || a.message.localeCompare(b.message))
}

export function evaluatePolicy(args: {
  policy: AdvisoryPolicy
  graphs: DependencyGraph[]
  current: AffectedInstance[]
  baseline?: AffectedInstance[]
  asOf: string
}): GateResult {
  const { policy, graphs, current, baseline, asOf } = args
  const asOfDay = utcDay(date(asOf, 'asOf'))
  const violations: PolicyViolation[] = []
  const add = (code: string, key: string, message: string, path: string[] = []) => {
    violations.push({ code, key, message, path: [...path] })
  }
  const capturedOnDay = utcDay(date(policy.capturedOn, 'policy.capturedOn'))
  if (capturedOnDay > asOfDay) {
    add('future-policy-capture', 'policy', `policy capture ${policy.capturedOn} is later than gate date ${asOf}`)
  }

  const graphBySource = new Map<LockSourceId, DependencyGraph>()
  for (const graph of graphs) {
    if (graphBySource.has(graph.source)) add('duplicate-graph', graph.source, `duplicate graph for ${graph.source}`)
    graphBySource.set(graph.source, graph)
  }
  for (const lockSource of LOCK_SOURCE_IDS) {
    const graph = graphBySource.get(lockSource)
    if (!graph) {
      add('missing-graph', lockSource, `missing dependency graph for ${lockSource}`)
    } else if (policy.currentLocks[lockSource] !== graph.lockSha256) {
      add('lock-hash-drift', lockSource, `policy lock hash ${policy.currentLocks[lockSource]} does not match ${graph.lockSha256}`)
    }
  }

  const decisions = new Map<string, AdvisoryDecision>()
  for (const decision of policy.decisions) {
    if (decisions.has(decision.key)) add('duplicate-decision-key', decision.key, 'decision key is duplicated')
    decisions.set(decision.key, decision)
    if (decision.key !== expectedDecisionKey(decision)) {
      add('decision-key-mismatch', decision.key, 'decision key does not match its advisory and package instance', decision.dependencyPaths[0])
    }
  }
  const currentByKey = new Map<string, AffectedInstance>()
  for (const item of current) {
    if (currentByKey.has(item.key)) add('duplicate-current-key', item.key, 'current affected-instance key is duplicated', item.dependencyPaths[0])
    currentByKey.set(item.key, item)
  }

  const baselineByKey = baseline === undefined ? undefined : new Map(baseline.map((item) => [item.key, item]))
  if (baseline !== undefined && baselineByKey) {
    for (const item of baseline) {
      const decision = decisions.get(item.key)
      if (!decision) add('missing-baseline-instance', item.key, 'supplied baseline instance has no decision', item.dependencyPaths[0])
      else if (!decision.baseline) add('baseline-flag-mismatch', item.key, 'supplied baseline instance is marked current-only', item.dependencyPaths[0])
    }
    for (const decision of policy.decisions.filter((entry) => entry.baseline)) {
      if (!baselineByKey.has(decision.key)) {
        add('baseline-decision-missing-instance', decision.key, 'baseline decision is absent from the supplied immutable baseline', decision.dependencyPaths[0])
      }
    }
  }

  for (const lockSource of LOCK_SOURCE_IDS) {
    const header = policy.baseline[lockSource]
    const sourceBaseline = baseline === undefined
      ? policy.decisions.filter((entry) => entry.baseline && entry.instance.source === lockSource)
      : baseline.filter((entry) => entry.node.lockSource === lockSource)
    const keys = sourceBaseline.map((entry) => entry.key)
    const computedHash = keyHash(keys)
    if (header.instanceKeysSha256 !== computedHash) {
      add('baseline-key-hash-drift', lockSource, `baseline key hash ${header.instanceKeysSha256} does not match ${computedHash}`)
    }
    if (header.instanceCount !== sourceBaseline.length) {
      add('baseline-instance-count-drift', lockSource, `baseline instance count ${header.instanceCount} does not match ${sourceBaseline.length}`)
    }
    const computedSeverity = advisorySeverityCounts(sourceBaseline)
    for (const conflict of computedSeverity.conflicts) {
      add('baseline-advisory-severity-conflict', conflict, 'one immutable baseline advisory row has conflicting severities')
    }
    const rawSeverityTotal = Object.values(header.severity).reduce((sum, count) => sum + count, 0)
    if (rawSeverityTotal !== header.advisoryRows) {
      add('baseline-advisory-row-drift', lockSource, `baseline advisory row count ${header.advisoryRows} does not match its severity total ${rawSeverityTotal}`)
    }
    if (Object.entries(computedSeverity.counts).some(([severity, count]) => header.severity[severity as Severity] < count)) {
      add('baseline-severity-drift', lockSource, 'baseline raw severity counts omit one or more distinct policy advisory identities')
    }
    const computedRows = advisoryRows(sourceBaseline)
    if (header.advisoryRows < computedRows) {
      add('baseline-advisory-row-drift', lockSource, `baseline advisory row count ${header.advisoryRows} is smaller than ${computedRows} distinct policy advisory identities`)
    }
  }

  for (const item of current) {
    const decision = decisions.get(item.key)
    if (!decision) {
      add('unknown-current-instance', item.key, 'current advisory instance has no policy decision', item.dependencyPaths[0])
      continue
    }
    if (decision.disposition === 'fixed') {
      add('fixed-advisory-reappeared', item.key, 'a decision marked fixed is present in the current audit', item.dependencyPaths[0])
      continue
    }
    if (decision.advisory.severity !== item.advisory.severity) {
      add('severity-drift', item.key, `severity changed from ${decision.advisory.severity} to ${item.advisory.severity}`, item.dependencyPaths[0])
    }
    if (
      decision.advisory.url !== item.advisory.url
      || decision.advisory.title !== item.advisory.title
      || decision.advisory.vulnerableRange !== item.advisory.vulnerableRange
    ) {
      add('advisory-drift', item.key, 'current advisory metadata differs from the policy decision', item.dependencyPaths[0])
    }
    if (
      decision.instance.source !== item.node.lockSource
      || decision.instance.packageName !== item.node.name
      || decision.instance.version !== item.node.version
      || decision.instance.lockKey !== item.node.lockKey
    ) {
      add('instance-drift', item.key, 'current package instance differs from the policy decision', item.dependencyPaths[0])
    }
    if (decision.automaticRole !== item.automaticRole) {
      add('automatic-role-drift', item.key, `automatic role changed from ${decision.automaticRole} to ${item.automaticRole}`, item.dependencyPaths[0])
    }
    if (!samePaths(decision.dependencyPaths, item.dependencyPaths)) {
      add('dependency-path-drift', item.key, 'current dependency paths differ from the policy decision', item.dependencyPaths[0])
    }
  }

  for (const decision of policy.decisions) {
    const reviewed = utcDay(date(decision.reviewedOn, `${decision.key}.reviewedOn`))
    if (reviewed > asOfDay || reviewed > capturedOnDay) {
      add(
        'future-decision-review',
        decision.key,
        `decision review ${decision.reviewedOn} is later than the gate or policy capture date`,
        decision.dependencyPaths[0],
      )
    }
    if (!hasAccountability(decision)) {
      add('missing-decision-accountability', decision.key, 'owner, rationale, and evidence must all be non-empty', decision.dependencyPaths[0])
    }
    if (roleImpact(decision.classification) < roleImpact(decision.automaticRole) && !hasDowngradeEvidence(decision)) {
      add('invalid-role-downgrade', decision.key, 'a lower classification requires source, command/test, and non-executable-path evidence', decision.dependencyPaths[0])
    }

    const currentItem = currentByKey.get(decision.key)
    if (decision.disposition === 'fixed') {
      if (!decision.fixedTarget?.trim() || !hasVerificationEvidence(decision.evidence)) {
        add('invalid-fixed-decision', decision.key, 'fixed decisions require a fixed target and verification evidence', decision.dependencyPaths[0])
      }
      if (decision.expiresOn !== undefined) {
        add('invalid-fixed-decision', decision.key, 'fixed decisions must not carry an exception expiry', decision.dependencyPaths[0])
      }
      continue
    }

    if (!currentItem) {
      add('accepted-risk-not-current', decision.key, 'accepted-risk decision is absent from the current audit and must be marked fixed', decision.dependencyPaths[0])
    }
    if (!decision.expiresOn) {
      add('invalid-accepted-risk', decision.key, 'accepted risks require an expiry date', decision.dependencyPaths[0])
    } else {
      let expires: number
      try {
        expires = utcDay(date(decision.expiresOn, `${decision.key}.expiresOn`))
      } catch {
        add('invalid-accepted-risk', decision.key, 'accepted-risk dates are invalid', decision.dependencyPaths[0])
        expires = 0
      }
      const limit = decision.advisory.severity === 'critical' || decision.advisory.severity === 'high' ? 30 : 90
      if (expires - reviewed > limit || expires < reviewed) {
        add('overlong-accepted-risk', decision.key, `${decision.advisory.severity} accepted risk exceeds ${limit} days`, decision.dependencyPaths[0])
      }
      if (asOfDay > expires) {
        add('expired-accepted-risk', decision.key, `accepted risk expired on ${decision.expiresOn}`, decision.dependencyPaths[0])
      }
    }
    if (
      decision.classification === 'runtime'
      && (decision.advisory.severity === 'critical' || decision.advisory.severity === 'high')
    ) {
      add('runtime-high-accepted-risk', decision.key, 'runtime critical/high findings cannot be accepted', decision.dependencyPaths[0])
    }
    if (decision.fixedTarget !== undefined) {
      add('invalid-accepted-risk', decision.key, 'accepted-risk decisions must not carry a fixed target', decision.dependencyPaths[0])
    }
  }

  for (const item of policy.overrides) {
    const key = item.packageName || '<empty>'
    if (
      !item.packageName.trim()
      || !EXACT_SEMVER.test(item.selectedVersion)
      || !item.blockedBy.trim()
      || !/[<>=~^]/.test(item.blockedBy)
      || !item.owner.trim()
      || !item.rationale.trim()
      || !item.evidence.some((entry) => entry.trim().length > 0)
      || !hasVerificationEvidence(item.evidence)
    ) {
      add('invalid-override', key, 'override requires exact package/version, blocked parent/range, accountability, and compatibility-test evidence')
    }
    let reviewed = 0
    let expires = 0
    try {
      reviewed = utcDay(date(item.reviewedOn, `${key}.reviewedOn`))
      expires = utcDay(date(item.expiresOn, `${key}.expiresOn`))
    } catch {
      add('invalid-override', key, 'override dates are invalid')
    }
    if (reviewed > asOfDay || reviewed > capturedOnDay) {
      add('future-override-review', key, `override review ${item.reviewedOn} is later than the gate or policy capture date`)
    }
    if (expires - reviewed > 30 || expires < reviewed) {
      add('overlong-override', key, 'override exceeds the 30-day maximum')
    }
    if (asOfDay > expires) {
      add('expired-override', key, `override expired on ${item.expiresOn}`)
    }
  }

  const classifications: Record<DependencyRole, number> = { runtime: 0, build: 0, development: 0, 'not-applicable': 0 }
  const dispositions = { fixed: 0, 'accepted-risk': 0 }
  for (const decision of policy.decisions) {
    classifications[decision.classification] += 1
    dispositions[decision.disposition] += 1
  }
  const currentSeverity = severityCounts(current)
  const roleSeverity: Record<DependencyRole, Record<Severity, number>> = {
    runtime: { critical: 0, high: 0, moderate: 0, low: 0 },
    build: { critical: 0, high: 0, moderate: 0, low: 0 },
    development: { critical: 0, high: 0, moderate: 0, low: 0 },
    'not-applicable': { critical: 0, high: 0, moderate: 0, low: 0 },
  }
  for (const item of current) {
    const finalRole = decisions.get(item.key)?.classification ?? item.automaticRole
    roleSeverity[finalRole][item.advisory.severity] += 1
  }
  const bySource = Object.fromEntries(LOCK_SOURCE_IDS.map((lockSource) => [
    lockSource,
    current.filter((item) => item.node.lockSource === lockSource).length,
  ]))
  const sorted = sortViolations(violations)
  return {
    ok: sorted.length === 0,
    violations: sorted,
    current: [...current].sort((a, b) => a.key.localeCompare(b.key)),
    summary: {
      currentInstances: current.length,
      severity: currentSeverity,
      classification: classifications,
      disposition: dispositions,
      lockSource: bySource,
      runtime: roleSeverity.runtime,
      build: roleSeverity.build,
      development: roleSeverity.development,
      'not-applicable': roleSeverity['not-applicable'],
      violations: sorted.length,
    },
  }
}
