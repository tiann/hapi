import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  captureAudit,
  matchAffectedInstances,
  OperationalAuditError,
  parseBunAudit,
  parseNpmAudit,
  type AuditCommandResult,
} from './audit'
import { loadRepositoryGraphs } from './lockGraph'
import type {
  Advisory,
  AdvisoryPolicy,
  GateOptions,
  GateResult,
  LockSourceId,
  PolicyViolation,
} from './model'
import { evaluatePolicy, parsePolicy } from './policy'

type AuditEvidence = {
  advisories: Advisory[]
  sha256: string
  mode: 'fresh-command' | 'explicit-file'
  exitCode?: number
}

type ManifestOverride = {
  packageName: string
  selectedVersion: string
  manifestPath: string
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.'
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) result[key] = stableValue(child)
    }
    return result
  }
  return value
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

async function writeStableJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, stableJson(value), { flag: 'wx', mode: 0o600 })
}

async function execute(command: string[], cwd: string): Promise<AuditCommandResult & { stdoutBytes: Uint8Array; stderrBytes: Uint8Array }> {
  let subprocess: ReturnType<typeof Bun.spawn>
  try {
    subprocess = Bun.spawn(command, { cwd, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    throw new OperationalAuditError(`could not start ${command.join(' ')}`, { cause: error })
  }
  const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
    new Response(subprocess.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
    new Response(subprocess.stderr as ReadableStream<Uint8Array>).arrayBuffer(),
    subprocess.exited,
  ])
  const stdoutBytes = new Uint8Array(stdoutBuffer)
  const stderrBytes = new Uint8Array(stderrBuffer)
  return {
    command,
    cwd,
    exitCode,
    stdout: new TextDecoder().decode(stdoutBytes),
    stderr: new TextDecoder().decode(stderrBytes),
    stdoutBytes,
    stderrBytes,
  }
}

async function commandValue(command: string[], cwd: string, label: string): Promise<string> {
  const result = await execute(command, cwd)
  if (result.exitCode !== 0 || result.stderr.trim().length > 0) {
    throw new OperationalAuditError(`${label} failed with exit ${result.exitCode}`)
  }
  const value = result.stdout.trim()
  if (value.length === 0 || value.includes('\n')) {
    throw new OperationalAuditError(`${label} returned an invalid value`)
  }
  return value
}

async function freshAudit(
  manager: 'bun' | 'npm',
  cwd: string,
  outputDirectory: string,
): Promise<AuditEvidence> {
  const command = manager === 'bun'
    ? ['bun', 'audit', '--json', '--production']
    : ['npm', 'audit', '--omit=dev', '--json']
  const result = await execute(command, cwd)
  const prefix = manager === 'bun' ? 'bun-audit-production' : 'npm-audit-production'
  await Promise.all([
    writeFile(join(outputDirectory, `${prefix}.json`), result.stdoutBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(join(outputDirectory, `${prefix}.stderr`), result.stderrBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(join(outputDirectory, `${prefix}.status`), `${result.exitCode}\n`, { flag: 'wx', mode: 0o600 }),
  ])
  const capture = await captureAudit(manager, cwd, async () => ({
    command: result.command,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }))
  return {
    advisories: capture.advisories,
    sha256: sha256(result.stdoutBytes),
    mode: 'fresh-command',
    exitCode: result.exitCode,
  }
}

async function explicitAudit(
  manager: 'bun' | 'npm',
  inputPath: string,
  outputDirectory: string,
): Promise<AuditEvidence> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(inputPath)
  } catch (error) {
    throw new OperationalAuditError(`could not read explicit ${manager} audit file`, { cause: error })
  }
  const stdout = new TextDecoder().decode(bytes)
  const advisories = manager === 'bun' ? parseBunAudit(stdout) : parseNpmAudit(stdout)
  const destination = manager === 'bun' ? 'bun-audit-production.json' : 'npm-audit-production.json'
  await writeFile(join(outputDirectory, destination), bytes, { flag: 'wx', mode: 0o600 })
  return { advisories, sha256: sha256(bytes), mode: 'explicit-file' }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OperationalAuditError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

async function collectManifestOverrides(
  repositoryRoot: string,
  bunGraph: Awaited<ReturnType<typeof loadRepositoryGraphs>>[number],
): Promise<ManifestOverride[]> {
  const workspaces = new Map<string, string>()
  for (const root of bunGraph.roots) {
    const existing = workspaces.get(root.path)
    if (existing && existing !== root.name) {
      throw new OperationalAuditError(`workspace ${root.path} has conflicting names`)
    }
    workspaces.set(root.path, root.name)
  }

  const overrides: ManifestOverride[] = []
  for (const [workspacePath, expectedName] of [...workspaces.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const manifestPath = workspacePath === '.'
      ? join(repositoryRoot, 'package.json')
      : join(repositoryRoot, workspacePath, 'package.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      throw new OperationalAuditError(`could not parse workspace manifest ${repositoryPath(repositoryRoot, manifestPath)}`, { cause: error })
    }
    const manifest = asObject(parsed, `manifest ${repositoryPath(repositoryRoot, manifestPath)}`)
    if (manifest.name !== expectedName) {
      throw new OperationalAuditError(`workspace manifest name mismatch at ${repositoryPath(repositoryRoot, manifestPath)}`)
    }
    if (manifest.overrides === undefined) continue
    const manifestOverrides = asObject(manifest.overrides, `manifest overrides ${repositoryPath(repositoryRoot, manifestPath)}`)
    for (const [packageName, selectedVersion] of Object.entries(manifestOverrides).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof selectedVersion !== 'string' || selectedVersion.length === 0) {
        throw new OperationalAuditError(`unsupported non-string override ${packageName} in ${repositoryPath(repositoryRoot, manifestPath)}`)
      }
      overrides.push({
        packageName,
        selectedVersion,
        manifestPath: repositoryPath(repositoryRoot, manifestPath),
      })
    }
  }
  return overrides
}

function overrideViolations(policy: AdvisoryPolicy, manifestOverrides: ManifestOverride[]): PolicyViolation[] {
  const violations: PolicyViolation[] = []
  const policyByName = new Map(policy.overrides.map((item) => [item.packageName, item]))
  const manifestByName = new Map<string, ManifestOverride[]>()
  for (const item of manifestOverrides) {
    const entries = manifestByName.get(item.packageName) ?? []
    entries.push(item)
    manifestByName.set(item.packageName, entries)
    const registered = policyByName.get(item.packageName)
    if (!registered) {
      violations.push({
        code: 'manifest-override-unregistered',
        key: item.packageName,
        message: `${item.manifestPath} selects ${item.selectedVersion} without a policy override`,
        path: [item.manifestPath],
      })
    } else if (registered.selectedVersion !== item.selectedVersion) {
      violations.push({
        code: 'override-version-drift',
        key: item.packageName,
        message: `manifest selects ${item.selectedVersion} but policy selects ${registered.selectedVersion}`,
        path: [item.manifestPath],
      })
    }
  }
  for (const item of policy.overrides) {
    if (!manifestByName.has(item.packageName)) {
      violations.push({
        code: 'policy-override-stale',
        key: item.packageName,
        message: 'policy override remains after the manifest override was removed',
        path: [],
      })
    }
  }
  for (const [packageName, items] of manifestByName) {
    const versions = new Set(items.map((item) => item.selectedVersion))
    if (versions.size > 1) {
      violations.push({
        code: 'manifest-override-conflict',
        key: packageName,
        message: `workspace manifests select conflicting override versions: ${[...versions].sort().join(', ')}`,
        path: items.map((item) => item.manifestPath).sort(),
      })
    }
  }
  return violations
}

function sortViolations(violations: PolicyViolation[]): PolicyViolation[] {
  return violations.sort((a, b) => a.code.localeCompare(b.code) || a.key.localeCompare(b.key) || a.message.localeCompare(b.message))
}

function summaryText(result: GateResult, asOf: string): string {
  const summary = result.summary as Record<string, any>
  const lines = [
    `dependency gate: ${result.ok ? 'PASS' : 'BLOCKED'}`,
    `as-of: ${asOf}`,
    `current instances: ${String(summary.currentInstances ?? result.current.length)}`,
    `violations: ${result.violations.length}`,
  ]
  const severity = summary.severity as Record<string, number> | undefined
  if (severity) {
    lines.push(`severity: critical=${severity.critical ?? 0} high=${severity.high ?? 0} moderate=${severity.moderate ?? 0} low=${severity.low ?? 0}`)
  }
  for (const violation of result.violations) {
    lines.push(`${violation.code}\t${violation.key}\t${violation.message}\t${violation.path.join(' -> ')}`)
  }
  return `${lines.join('\n')}\n`
}

export async function runDependencyGate(options: GateOptions): Promise<GateResult> {
  const repositoryRoot = resolve(options.repositoryRoot)
  const outputDirectory = isAbsolute(options.outputDirectory)
    ? options.outputDirectory
    : resolve(repositoryRoot, options.outputDirectory)
  const policyPath = isAbsolute(options.policyPath)
    ? options.policyPath
    : resolve(repositoryRoot, options.policyPath)
  const explicitCount = Number(options.bunAuditJsonPath !== undefined) + Number(options.npmAuditJsonPath !== undefined)
  if (explicitCount === 1) {
    throw new OperationalAuditError('explicit audit mode requires both Bun and npm JSON files')
  }

  try {
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    if ((await readdir(outputDirectory)).length !== 0) {
      throw new OperationalAuditError('dependency gate output directory is not empty')
    }
  } catch (error) {
    if (error instanceof OperationalAuditError) throw error
    throw new OperationalAuditError('could not create dependency gate output directory', { cause: error })
  }

  let policy: AdvisoryPolicy
  try {
    policy = parsePolicy(JSON.parse(await readFile(policyPath, 'utf8')))
  } catch (error) {
    if (error instanceof OperationalAuditError) throw error
    throw new OperationalAuditError('could not parse dependency policy', { cause: error })
  }

  let graphs: Awaited<ReturnType<typeof loadRepositoryGraphs>>
  try {
    graphs = await loadRepositoryGraphs(repositoryRoot)
  } catch (error) {
    throw new OperationalAuditError('could not load dependency lock graphs', { cause: error })
  }
  const bunGraph = graphs.find((graph) => graph.source === 'bun-workspaces')
  const npmGraph = graphs.find((graph) => graph.source === 'hapi-codex-sync')
  if (!bunGraph || !npmGraph) throw new OperationalAuditError('both supported lock graphs are required')

  const bunEvidence = explicitCount === 2
    ? await explicitAudit('bun', resolve(options.bunAuditJsonPath!), outputDirectory)
    : await freshAudit('bun', repositoryRoot, outputDirectory)
  const npmEvidence = explicitCount === 2
    ? await explicitAudit('npm', resolve(options.npmAuditJsonPath!), outputDirectory)
    : await freshAudit('npm', join(repositoryRoot, 'tools/hapi-codex-sync'), outputDirectory)

  let current
  try {
    current = [
      ...matchAffectedInstances(bunGraph, bunEvidence.advisories),
      ...matchAffectedInstances(npmGraph, npmEvidence.advisories),
    ].sort((a, b) => a.key.localeCompare(b.key))
  } catch (error) {
    if (error instanceof OperationalAuditError) throw error
    throw new OperationalAuditError('could not match current affected instances', { cause: error })
  }

  let result = evaluatePolicy({ policy, graphs, current, asOf: options.asOf })
  const manifestOverrides = await collectManifestOverrides(repositoryRoot, bunGraph)
  const violations = sortViolations([...result.violations, ...overrideViolations(policy, manifestOverrides)])
  result = {
    ...result,
    ok: violations.length === 0,
    violations,
    summary: {
      ...result.summary,
      manifestOverrides: manifestOverrides.length,
      policyOverrides: policy.overrides.length,
      violations: violations.length,
    },
  }

  const [gitSha, npmVersion] = await Promise.all([
    commandValue(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD'], repositoryRoot, 'git revision'),
    commandValue(['npm', '--version'], repositoryRoot, 'npm version'),
  ])
  if (!/^[a-f0-9]{40,64}$/.test(gitSha)) {
    throw new OperationalAuditError('git revision is not a full hexadecimal commit')
  }
  const metadata = {
    schemaVersion: 1,
    gitSha,
    asOf: options.asOf,
    packageManagers: { bun: Bun.version, npm: npmVersion },
    locks: {
      'bun-workspaces': { sha256: bunGraph.lockSha256 },
      'hapi-codex-sync': { sha256: npmGraph.lockSha256 },
    },
    audits: {
      bun: {
        mode: bunEvidence.mode,
        sha256: bunEvidence.sha256,
        ...(bunEvidence.exitCode === undefined ? {} : { exitCode: bunEvidence.exitCode }),
      },
      npm: {
        mode: npmEvidence.mode,
        sha256: npmEvidence.sha256,
        ...(npmEvidence.exitCode === undefined ? {} : { exitCode: npmEvidence.exitCode }),
      },
    },
  }

  try {
    await Promise.all([
      writeStableJson(join(outputDirectory, 'dependency-affected-instances.json'), current),
      writeStableJson(join(outputDirectory, 'dependency-audit-summary.json'), {
        ok: result.ok,
        summary: result.summary,
        violations: result.violations,
      }),
      writeFile(join(outputDirectory, 'dependency-audit-summary.txt'), summaryText(result, options.asOf), { flag: 'wx', mode: 0o600 }),
      writeStableJson(join(outputDirectory, 'dependency-gate-metadata.json'), metadata),
    ])
  } catch (error) {
    throw new OperationalAuditError('could not write dependency gate outputs', { cause: error })
  }
  return result
}

export function gateExitCode(outcome: { result?: GateResult; error?: unknown }): 0 | 1 | 2 {
  const hasResult = outcome.result !== undefined
  const hasError = outcome.error !== undefined
  if (hasResult === hasError) return 2
  if (hasError) return 2
  const result = outcome.result
  if (
    !result
    || typeof result.ok !== 'boolean'
    || !Array.isArray(result.violations)
    || !Array.isArray(result.current)
    || typeof result.summary !== 'object'
    || result.summary === null
  ) return 2
  if (result.ok && result.violations.length === 0) return 0
  if (!result.ok && result.violations.length > 0) return 1
  return 2
}
