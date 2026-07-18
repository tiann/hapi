import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  captureAudit,
  matchAffectedInstances,
  parseBunAudit,
  parseNpmAudit,
  type AuditCommandResult,
} from './audit'
import { gateExitCode, runDependencyGate } from './gate'
import {
  loadRepositoryGraphs,
  parseBunLockGraph,
  parseNpmLockGraph,
} from './lockGraph'
import type {
  Advisory,
  AdvisoryDecision,
  AdvisoryPolicy,
  AffectedInstance,
  DependencyGraph,
  GateOptions,
  GateResult,
  Severity,
} from './model'
import { writeSboms, type SbomResult } from './sbom'

export type InventoryOptions = {
  repositoryRoot: string
  outputDirectory: string
  asOf: string
  baselineBunLockPath: string
  baselineNpmLockPath: string
  baselineBunAuditJsonPath: string
  baselineNpmAuditJsonPath: string
  bunAuditJsonPath?: string
  npmAuditJsonPath?: string
}

export type InventoryResult = { outputPaths: string[] }
export type SbomCommandOptions = {
  repositoryRoot: string
  policyPath: string
  outputDirectory: string
  gitSha: string
  graphs?: DependencyGraph[]
}
export type CliOperations = {
  inventory(options: InventoryOptions): Promise<InventoryResult>
  gate(options: GateOptions): Promise<GateResult>
  sbom(options: SbomCommandOptions): Promise<SbomResult>
}
export type CliContext = {
  cwd: string
  operations: CliOperations
  stdout(value: string): void
  stderr(value: string): void
}

type ManagerEvidence = {
  advisories: Advisory[]
  sha256: string
  source: 'fresh-command' | 'explicit-file'
  exitCode?: number
}

const POLICY_RELATIVE_PATH = 'security/dependencies/advisory-matrix.json'
const DATE = /^\d{4}-\d{2}-\d{2}$/
const GIT_SHA = /^[a-f0-9]{40}$/

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
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

function calendarDate(value: string, label: string): string {
  if (!DATE.test(value)) throw new Error(`${label} must use exact YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`)
  }
  return value
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function pathContains(parent: string, child: string): boolean {
  const nested = relative(parent, child)
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))
}

function assertInventoryOutputSafe(repositoryRoot: string, outputDirectory: string): void {
  const policyPath = resolve(repositoryRoot, POLICY_RELATIVE_PATH)
  if (pathContains(outputDirectory, policyPath) || pathContains(policyPath, outputDirectory)) {
    throw new Error('inventory output must not equal or contain the checked-in advisory policy path')
  }
}

async function initializeEmptyOutput(outputDirectory: string, label: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  if ((await readdir(outputDirectory)).length !== 0) throw new Error(`${label} output directory is not empty`)
}

async function execute(command: string[], cwd: string): Promise<AuditCommandResult & {
  stdoutBytes: Uint8Array
  stderrBytes: Uint8Array
}> {
  const subprocess = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
    new Response(subprocess.stdout).arrayBuffer(),
    new Response(subprocess.stderr).arrayBuffer(),
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

async function commandText(command: string[], cwd: string, allowEmpty = false): Promise<string> {
  const result = await execute(command, cwd)
  if (result.exitCode !== 0) throw new Error(`${command[0]} command failed with exit ${result.exitCode}`)
  const value = result.stdout.trim()
  if ((!allowEmpty && value.length === 0) || result.stderr.trim().length !== 0) {
    throw new Error(`${command[0]} command returned an invalid result`)
  }
  return value
}

async function freshAudit(
  manager: 'bun' | 'npm',
  cwd: string,
  outputDirectory: string,
): Promise<ManagerEvidence> {
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
    source: 'fresh-command',
    exitCode: result.exitCode,
  }
}

async function explicitAudit(
  manager: 'bun' | 'npm',
  inputPath: string,
  outputDirectory: string,
): Promise<ManagerEvidence> {
  const bytes = await readFile(inputPath)
  const text = new TextDecoder().decode(bytes)
  const advisories = manager === 'bun' ? parseBunAudit(text) : parseNpmAudit(text)
  const filename = manager === 'bun' ? 'bun-audit-production.json' : 'npm-audit-production.json'
  await writeFile(join(outputDirectory, filename), bytes, { flag: 'wx', mode: 0o600 })
  return { advisories, sha256: sha256(bytes), source: 'explicit-file' }
}

function emptySeverity(): Record<Severity, number> {
  return { critical: 0, high: 0, moderate: 0, low: 0 }
}

function advisorySeverity(advisories: Advisory[]): Record<Severity, number> {
  const result = emptySeverity()
  for (const advisory of advisories) result[advisory.severity] += 1
  return result
}

function instanceKeySha(instances: AffectedInstance[]): string {
  const keys = instances.map((item) => item.key).sort()
  return sha256(keys.length === 0 ? '' : `${keys.join('\n')}\n`)
}

function decisionFromInstance(
  item: AffectedInstance,
  baseline: boolean,
  state: 'fixed' | 'current',
  asOf: string,
): AdvisoryDecision {
  const common = {
    key: item.key,
    baseline,
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
    owner: '',
    rationale: '',
    evidence: [],
    reviewedOn: asOf,
  }
  if (state === 'fixed') {
    return { ...common, disposition: 'fixed', fixedTarget: '' }
  }
  const ceiling = item.advisory.severity === 'critical' || item.advisory.severity === 'high' ? 30 : 90
  return { ...common, disposition: 'accepted-risk', expiresOn: addDays(asOf, ceiling) }
}

async function candidateOverrides(
  repositoryRoot: string,
  graph: DependencyGraph,
  asOf: string,
): Promise<AdvisoryPolicy['overrides']> {
  const workspaces = new Map(graph.roots.map((root) => [root.path, root.name]))
  const selected = new Map<string, string>()
  for (const [workspacePath] of [...workspaces].sort(([a], [b]) => a.localeCompare(b))) {
    const manifestPath = workspacePath === '.'
      ? join(repositoryRoot, 'package.json')
      : join(repositoryRoot, workspacePath, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    if (manifest.overrides === undefined) continue
    if (typeof manifest.overrides !== 'object' || manifest.overrides === null || Array.isArray(manifest.overrides)) {
      throw new Error(`manifest overrides are malformed in ${workspacePath}`)
    }
    for (const [packageName, version] of Object.entries(manifest.overrides)) {
      if (typeof version !== 'string' || version.length === 0) throw new Error(`manifest override ${packageName} is not an exact string`)
      const existing = selected.get(packageName)
      if (existing !== undefined && existing !== version) throw new Error(`manifest override ${packageName} has conflicting versions`)
      selected.set(packageName, version)
    }
  }
  return [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([packageName, selectedVersion]) => ({
    packageName,
    selectedVersion,
    blockedBy: '',
    owner: '',
    rationale: '',
    evidence: [],
    reviewedOn: asOf,
    expiresOn: addDays(asOf, 30),
  }))
}

function instanceCounts(instances: AffectedInstance[]): Record<string, unknown> {
  const lockSource = { 'bun-workspaces': 0, 'hapi-codex-sync': 0 }
  const severity = emptySeverity()
  const automaticRole = { runtime: 0, build: 0, development: 0, 'not-applicable': 0 }
  const roleSeverity = {
    runtime: emptySeverity(),
    build: emptySeverity(),
    development: emptySeverity(),
    'not-applicable': emptySeverity(),
  }
  for (const item of instances) {
    lockSource[item.node.lockSource] += 1
    severity[item.advisory.severity] += 1
    automaticRole[item.automaticRole] += 1
    roleSeverity[item.automaticRole][item.advisory.severity] += 1
  }
  return { instances: instances.length, lockSource, severity, automaticRole, roleSeverity }
}

export async function runDependencyInventory(options: InventoryOptions): Promise<InventoryResult> {
  const repositoryRoot = resolve(options.repositoryRoot)
  const outputDirectory = isAbsolute(options.outputDirectory)
    ? options.outputDirectory
    : resolve(repositoryRoot, options.outputDirectory)
  calendarDate(options.asOf, 'inventory --as-of')
  assertInventoryOutputSafe(repositoryRoot, outputDirectory)
  await initializeEmptyOutput(outputDirectory, 'inventory')
  const currentPair = Number(options.bunAuditJsonPath !== undefined) + Number(options.npmAuditJsonPath !== undefined)
  if (currentPair === 1) throw new Error('current Bun/npm audit JSON paths must be supplied as a pair')

  const [
    baselineBunGraph,
    baselineNpmGraph,
    currentGraphs,
    baselineBunAuditBytes,
    baselineNpmAuditBytes,
  ] = await Promise.all([
    parseBunLockGraph(options.baselineBunLockPath),
    parseNpmLockGraph(options.baselineNpmLockPath),
    loadRepositoryGraphs(repositoryRoot),
    readFile(options.baselineBunAuditJsonPath),
    readFile(options.baselineNpmAuditJsonPath),
  ])
  const currentBunGraph = currentGraphs.find((graph) => graph.source === 'bun-workspaces')
  const currentNpmGraph = currentGraphs.find((graph) => graph.source === 'hapi-codex-sync')
  if (!currentBunGraph || !currentNpmGraph) throw new Error('inventory requires both supported current lock graphs')
  const baselineBunAdvisories = parseBunAudit(new TextDecoder().decode(baselineBunAuditBytes))
  const baselineNpmAdvisories = parseNpmAudit(new TextDecoder().decode(baselineNpmAuditBytes))
  const baselineBun = matchAffectedInstances(baselineBunGraph, baselineBunAdvisories)
  const baselineNpm = matchAffectedInstances(baselineNpmGraph, baselineNpmAdvisories)
  const baseline = [...baselineBun, ...baselineNpm].sort((a, b) => a.key.localeCompare(b.key))

  const bunEvidence = currentPair === 2
    ? await explicitAudit('bun', resolve(options.bunAuditJsonPath!), outputDirectory)
    : await freshAudit('bun', repositoryRoot, outputDirectory)
  const npmEvidence = currentPair === 2
    ? await explicitAudit('npm', resolve(options.npmAuditJsonPath!), outputDirectory)
    : await freshAudit('npm', join(repositoryRoot, 'tools/hapi-codex-sync'), outputDirectory)
  const current = [
    ...matchAffectedInstances(currentBunGraph, bunEvidence.advisories),
    ...matchAffectedInstances(currentNpmGraph, npmEvidence.advisories),
  ].sort((a, b) => a.key.localeCompare(b.key))

  const baselineByKey = new Map(baseline.map((item) => [item.key, item]))
  const currentByKey = new Map(current.map((item) => [item.key, item]))
  const decisions: AdvisoryDecision[] = []
  for (const baselineItem of baseline) {
    const currentItem = currentByKey.get(baselineItem.key)
    decisions.push(decisionFromInstance(
      currentItem ?? baselineItem,
      true,
      currentItem ? 'current' : 'fixed',
      options.asOf,
    ))
  }
  for (const currentItem of current) {
    if (!baselineByKey.has(currentItem.key)) decisions.push(decisionFromInstance(currentItem, false, 'current', options.asOf))
  }
  decisions.sort((a, b) => a.key.localeCompare(b.key))

  const npmVersion = await commandText(['npm', '--version'], repositoryRoot)
  const candidate: AdvisoryPolicy = {
    schemaVersion: 1,
    capturedOn: options.asOf,
    packageManagers: { bun: Bun.version, npm: npmVersion },
    baseline: {
      'bun-workspaces': {
        lockSha256: baselineBunGraph.lockSha256,
        auditSha256: sha256(baselineBunAuditBytes),
        advisoryRows: baselineBunAdvisories.length,
        instanceCount: baselineBun.length,
        instanceKeysSha256: instanceKeySha(baselineBun),
        severity: advisorySeverity(baselineBunAdvisories),
      },
      'hapi-codex-sync': {
        lockSha256: baselineNpmGraph.lockSha256,
        auditSha256: sha256(baselineNpmAuditBytes),
        advisoryRows: baselineNpmAdvisories.length,
        instanceCount: baselineNpm.length,
        instanceKeysSha256: instanceKeySha(baselineNpm),
        severity: advisorySeverity(baselineNpmAdvisories),
      },
    },
    currentLocks: {
      'bun-workspaces': currentBunGraph.lockSha256,
      'hapi-codex-sync': currentNpmGraph.lockSha256,
    },
    decisions,
    overrides: await candidateOverrides(repositoryRoot, currentBunGraph, options.asOf),
  }
  const summary = {
    baseline: {
      ...instanceCounts(baseline),
      advisoryRows: baselineBunAdvisories.length + baselineNpmAdvisories.length,
      advisorySeverity: advisorySeverity([...baselineBunAdvisories, ...baselineNpmAdvisories]),
    },
    current: {
      ...instanceCounts(current),
      advisoryRows: bunEvidence.advisories.length + npmEvidence.advisories.length,
      advisorySeverity: advisorySeverity([...bunEvidence.advisories, ...npmEvidence.advisories]),
    },
    state: {
      fixed: baseline.filter((item) => !currentByKey.has(item.key)).length,
      baselineCurrent: baseline.filter((item) => currentByKey.has(item.key)).length,
      currentOnly: current.filter((item) => !baselineByKey.has(item.key)).length,
    },
    runtime: (instanceCounts(current).roleSeverity as Record<string, unknown>).runtime,
  }
  const metadata = {
    schemaVersion: 1,
    asOf: options.asOf,
    packageManagers: candidate.packageManagers,
    baseline: {
      locks: {
        'bun-workspaces': baselineBunGraph.lockSha256,
        'hapi-codex-sync': baselineNpmGraph.lockSha256,
      },
      audits: {
        bun: { sha256: sha256(baselineBunAuditBytes), source: 'explicit-file' },
        npm: { sha256: sha256(baselineNpmAuditBytes), source: 'explicit-file' },
      },
    },
    current: {
      locks: candidate.currentLocks,
      audits: {
        bun: {
          sha256: bunEvidence.sha256,
          source: bunEvidence.source,
          ...(bunEvidence.exitCode === undefined ? {} : { exitCode: bunEvidence.exitCode }),
        },
        npm: {
          sha256: npmEvidence.sha256,
          source: npmEvidence.source,
          ...(npmEvidence.exitCode === undefined ? {} : { exitCode: npmEvidence.exitCode }),
        },
      },
    },
  }

  const outputPaths = [
    join(outputDirectory, 'advisory-matrix.candidate.json'),
    join(outputDirectory, 'baseline-affected-instances.json'),
    join(outputDirectory, 'current-affected-instances.json'),
    join(outputDirectory, 'dependency-inventory-summary.json'),
    join(outputDirectory, 'dependency-inventory-metadata.json'),
  ]
  await Promise.all([
    writeFile(outputPaths[0], stableJson(candidate), { flag: 'wx', mode: 0o600 }),
    writeFile(outputPaths[1], stableJson(baseline), { flag: 'wx', mode: 0o600 }),
    writeFile(outputPaths[2], stableJson(current), { flag: 'wx', mode: 0o600 }),
    writeFile(outputPaths[3], stableJson(summary), { flag: 'wx', mode: 0o600 }),
    writeFile(outputPaths[4], stableJson(metadata), { flag: 'wx', mode: 0o600 }),
  ])
  return { outputPaths }
}

async function verifyExplicitGitIdentity(repositoryRoot: string, gitSha: string): Promise<void> {
  if (!GIT_SHA.test(gitSha)) throw new Error('--git-sha must be exactly 40 lowercase hexadecimal characters')
  const head = await commandText(['git', '-C', repositoryRoot, 'rev-parse', 'HEAD'], repositoryRoot)
  if (head !== gitSha) throw new Error('supplied --git-sha does not match repository HEAD')
  const status = await commandText(
    ['git', '-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=normal'],
    repositoryRoot,
    true,
  )
  if (status.length !== 0) throw new Error('SBOM generation requires a clean explicit Git identity')
}

const defaultOperations: CliOperations = {
  inventory: runDependencyInventory,
  gate: runDependencyGate,
  sbom: async (options) => {
    await verifyExplicitGitIdentity(options.repositoryRoot, options.gitSha)
    const graphs = options.graphs ?? await loadRepositoryGraphs(options.repositoryRoot)
    return writeSboms({
      graphs,
      policyPath: options.policyPath,
      outputDirectory: options.outputDirectory,
      gitSha: options.gitSha,
    })
  },
}

function parseFlags(args: string[], allowed: string[], required: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const allowedSet = new Set(allowed)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !allowedSet.has(flag)) throw new Error(`unknown flag ${flag ?? '<missing>'}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`flag ${flag} requires a value`)
    if (result.has(flag)) throw new Error(`duplicate flag ${flag}`)
    result.set(flag, value)
  }
  for (const flag of required) {
    if (!result.has(flag)) throw new Error(`missing required flag ${flag}`)
  }
  return result
}

function absolutePath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function paired(flags: Map<string, string>, first: string, second: string): void {
  if (flags.has(first) !== flags.has(second)) throw new Error(`${first} and ${second} must be supplied as a pair`)
}

function redactError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  message = message.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
  message = message.replace(/\b(token|password|secret|authorization|auth|credential)=([^\s&]+)/gi, '$1=[REDACTED]')
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /(token|password|secret|authorization|auth|credential|api[_-]?key)/i.test(name)) {
      message = message.split(value).join('[REDACTED]')
    }
  }
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 1000)
}

export async function runCli(argv: string[], partial: Partial<CliContext> = {}): Promise<number> {
  const context: CliContext = {
    cwd: partial.cwd ?? process.cwd(),
    operations: partial.operations ?? defaultOperations,
    stdout: partial.stdout ?? ((value) => { process.stdout.write(value) }),
    stderr: partial.stderr ?? ((value) => { process.stderr.write(value) }),
  }
  try {
    const [command, ...args] = argv
    const policyPath = resolve(context.cwd, POLICY_RELATIVE_PATH)
    if (command === 'inventory') {
      const flags = parseFlags(args, [
        '--out',
        '--as-of',
        '--baseline-bun-lock',
        '--baseline-npm-lock',
        '--baseline-bun-audit-json',
        '--baseline-npm-audit-json',
        '--bun-audit-json',
        '--npm-audit-json',
      ], [
        '--out',
        '--as-of',
        '--baseline-bun-lock',
        '--baseline-npm-lock',
        '--baseline-bun-audit-json',
        '--baseline-npm-audit-json',
      ])
      paired(flags, '--bun-audit-json', '--npm-audit-json')
      const outputDirectory = absolutePath(context.cwd, flags.get('--out')!)
      calendarDate(flags.get('--as-of')!, '--as-of')
      assertInventoryOutputSafe(context.cwd, outputDirectory)
      const result = await context.operations.inventory({
        repositoryRoot: resolve(context.cwd),
        outputDirectory,
        asOf: flags.get('--as-of')!,
        baselineBunLockPath: absolutePath(context.cwd, flags.get('--baseline-bun-lock')!),
        baselineNpmLockPath: absolutePath(context.cwd, flags.get('--baseline-npm-lock')!),
        baselineBunAuditJsonPath: absolutePath(context.cwd, flags.get('--baseline-bun-audit-json')!),
        baselineNpmAuditJsonPath: absolutePath(context.cwd, flags.get('--baseline-npm-audit-json')!),
        ...(flags.has('--bun-audit-json') ? {
          bunAuditJsonPath: absolutePath(context.cwd, flags.get('--bun-audit-json')!),
          npmAuditJsonPath: absolutePath(context.cwd, flags.get('--npm-audit-json')!),
        } : {}),
      })
      result.outputPaths.forEach((path) => context.stdout(`${path}\n`))
      return 0
    }
    if (command === 'gate') {
      const flags = parseFlags(args, ['--out', '--as-of', '--bun-audit-json', '--npm-audit-json'], ['--out', '--as-of'])
      paired(flags, '--bun-audit-json', '--npm-audit-json')
      calendarDate(flags.get('--as-of')!, '--as-of')
      const outputDirectory = absolutePath(context.cwd, flags.get('--out')!)
      const result = await context.operations.gate({
        repositoryRoot: resolve(context.cwd),
        policyPath,
        outputDirectory,
        asOf: flags.get('--as-of')!,
        ...(flags.has('--bun-audit-json') ? {
          bunAuditJsonPath: absolutePath(context.cwd, flags.get('--bun-audit-json')!),
          npmAuditJsonPath: absolutePath(context.cwd, flags.get('--npm-audit-json')!),
        } : {}),
      })
      context.stdout(`${join(outputDirectory, 'dependency-audit-summary.json')}\n`)
      return gateExitCode({ result })
    }
    if (command === 'sbom') {
      const flags = parseFlags(args, ['--out', '--git-sha'], ['--out', '--git-sha'])
      const gitSha = flags.get('--git-sha')!
      if (!GIT_SHA.test(gitSha)) throw new Error('--git-sha must be exactly 40 lowercase hexadecimal characters')
      const result = await context.operations.sbom({
        graphs: undefined,
        policyPath,
        repositoryRoot: resolve(context.cwd),
        outputDirectory: absolutePath(context.cwd, flags.get('--out')!),
        gitSha,
      })
      context.stdout(`${result.bunPath}\n${result.npmPath}\n${result.manifestPath}\n`)
      return 0
    }
    throw new Error(`unknown command ${command ?? '<missing>'}`)
  } catch (error) {
    context.stderr(`dependency-security: ${redactError(error)}\n`)
    return 2
  }
}

if (import.meta.main) {
  process.exit(await runCli(Bun.argv.slice(2)))
}
