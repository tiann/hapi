export const LOCK_SOURCE_IDS = ['bun-workspaces', 'hapi-codex-sync'] as const
export type LockSourceId = typeof LOCK_SOURCE_IDS[number]
export type DependencyRole = 'runtime' | 'build' | 'development' | 'not-applicable'
export type DependencyKind = 'dependency' | 'optional' | 'dev'
export type Severity = 'critical' | 'high' | 'moderate' | 'low'

export type PlatformConstraint = { os: string[]; cpu: string[] } | null
export type DependencyEdge = { from: string; to: string; kind: DependencyKind }
export type DependencyRoot = {
  ref: string
  name: string
  path: string
  role: DependencyRole
  dependencies: Array<{ name: string; range: string; kind: DependencyKind }>
}
export type PackageNode = {
  ref: string
  lockSource: LockSourceId
  lockKey: string
  name: string
  version: string
  integrity: string | null
  purl: string
  platform: PlatformConstraint
  roles: DependencyRole[]
  paths: string[][]
}
export type DependencyGraph = {
  source: LockSourceId
  lockPath: string
  lockSha256: string
  roots: DependencyRoot[]
  nodes: PackageNode[]
  edges: DependencyEdge[]
}
export type Advisory = {
  source: LockSourceId
  id: string
  url: string
  title: string
  severity: Severity
  vulnerableRange: string
  packageName: string
}
export type AffectedInstance = {
  key: string
  advisory: Advisory
  node: PackageNode
  automaticRole: DependencyRole
  dependencyPaths: string[][]
}
export type AuditCapture = {
  manager: 'bun' | 'npm'
  command: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  advisories: Advisory[]
}
export type Disposition = 'fixed' | 'accepted-risk'
export type AdvisoryDecision = {
  key: string
  baseline: boolean
  advisory: { url: string; title: string; severity: Severity; vulnerableRange: string }
  instance: { source: LockSourceId; packageName: string; version: string; lockKey: string }
  automaticRole: DependencyRole
  classification: DependencyRole
  dependencyPaths: string[][]
  disposition: Disposition
  owner: string
  rationale: string
  evidence: string[]
  reviewedOn: string
  expiresOn?: string
  fixedTarget?: string
}
export type AdvisoryPolicy = {
  schemaVersion: 1
  capturedOn: string
  packageManagers: { bun: string; npm: string }
  baseline: Record<LockSourceId, { lockSha256: string; auditSha256: string; advisoryRows: number; instanceCount: number; instanceKeysSha256: string; severity: Record<Severity, number> }>
  currentLocks: Record<LockSourceId, string>
  decisions: AdvisoryDecision[]
  overrides: Array<{ packageName: string; selectedVersion: string; blockedBy: string; owner: string; rationale: string; evidence: string[]; reviewedOn: string; expiresOn: string }>
}
export type PolicyViolation = { code: string; key: string; message: string; path: string[] }
export type GateResult = { ok: boolean; violations: PolicyViolation[]; current: AffectedInstance[]; summary: Record<string, unknown> }
export type GateOptions = {
  repositoryRoot: string
  policyPath: string
  outputDirectory: string
  asOf: string
  bunAuditJsonPath?: string
  npmAuditJsonPath?: string
}
