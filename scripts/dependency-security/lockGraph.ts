import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import type {
  DependencyEdge,
  DependencyGraph,
  DependencyKind,
  DependencyRole,
  DependencyRoot,
  LockSourceId,
  PackageNode,
  PlatformConstraint,
} from './model'

type UnknownRecord = Record<string, unknown>
type RootSeed = {
  root: DependencyRoot
  targets: Array<{ ref: string; kind: DependencyKind }>
}

const ROLE_ORDER: DependencyRole[] = ['runtime', 'build', 'development', 'not-applicable']
const LOCK_NAMES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'])
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function roleImpact(role: DependencyRole): number {
  return ROLE_ORDER.length - ROLE_ORDER.indexOf(role)
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function lockRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/')
  return value || basename(path)
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertSemver(version: string, label: string): void {
  if (!SEMVER.test(version)) {
    throw new Error(`malformed version for ${label}: ${version}`)
  }
}

function integrity(value: unknown, label: string): string {
  const parsed = typeof value === 'string' ? value : ''
  if (!parsed.startsWith('sha512-') || parsed.length === 'sha512-'.length) {
    throw new Error(`missing registry integrity for ${label}`)
  }
  return parsed
}

function packageIdentity(identity: unknown, label: string): { name: string; version: string } {
  const parsed = requireString(identity, `${label} identity`)
  const separator = parsed.lastIndexOf('@')
  if (separator <= 0 || separator === parsed.length - 1) {
    throw new Error(`malformed package identity for ${label}: ${parsed}`)
  }
  const name = parsed.slice(0, separator)
  const version = parsed.slice(separator + 1)
  if (name.includes(' ') || (!name.startsWith('@') && name.includes('/')) || (name.startsWith('@') && !/^@[^/]+\/[^/]+$/.test(name))) {
    throw new Error(`malformed package name for ${label}: ${name}`)
  }
  assertSemver(version, label)
  return { name, version }
}

function npmPurl(name: string, version: string): string {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    const scope = name.slice(0, slash)
    const unscoped = name.slice(slash + 1)
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(unscoped)}@${encodeURIComponent(version)}`
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return []
  }
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} must be a string or array of non-empty strings`)
  }
  return [...new Set(values)].sort()
}

function platformConstraint(metadata: UnknownRecord, label: string): PlatformConstraint {
  const os = stringList(metadata.os, `${label} os`)
  const cpu = stringList(metadata.cpu, `${label} cpu`)
  return os.length === 0 && cpu.length === 0 ? null : { os, cpu }
}

function dependencyEntries(
  value: unknown,
  kind: DependencyKind,
  label: string,
): Array<{ name: string; range: string; kind: DependencyKind }> {
  if (value === undefined) {
    return []
  }
  const record = requireRecord(value, label)
  return Object.entries(record)
    .map(([name, range]) => {
      if (name.length === 0 || typeof range !== 'string' || range.length === 0) {
        throw new Error(`${label} contains a malformed dependency`)
      }
      return { name, range, kind }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
}

function mergeDependencyEntries(
  ...groups: Array<Array<{ name: string; range: string; kind: DependencyKind }>>
): Array<{ name: string; range: string; kind: DependencyKind }> {
  const priority: Record<DependencyKind, number> = { dependency: 3, optional: 2, dev: 1 }
  const merged = new Map<string, { name: string; range: string; kind: DependencyKind }>()
  for (const entry of groups.flat()) {
    const current = merged.get(entry.name)
    if (!current || priority[entry.kind] > priority[current.kind]) {
      merged.set(entry.name, entry)
    } else if (current.range !== entry.range && priority[entry.kind] === priority[current.kind]) {
      throw new Error(`conflicting dependency ranges for ${entry.name}`)
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
}

function productionRole(workspacePath: string): DependencyRole {
  return workspacePath === 'docs' ? 'build' : 'runtime'
}

function developmentRole(workspacePath: string): DependencyRole {
  return ['docs', 'web', 'website'].includes(workspacePath) ? 'build' : 'development'
}

function rootRef(source: LockSourceId, path: string): string {
  return `${source}:workspace:${path}`
}

function rootGroups(
  source: LockSourceId,
  workspacePath: string,
  workspace: UnknownRecord,
): DependencyRoot[] {
  const name = requireString(workspace.name, `workspace ${workspacePath || '.'} name`)
  const path = workspacePath || '.'
  const production = mergeDependencyEntries(
    dependencyEntries(workspace.dependencies, 'dependency', `workspace ${path} dependencies`),
    dependencyEntries(workspace.optionalDependencies, 'optional', `workspace ${path} optionalDependencies`),
    dependencyEntries(workspace.peerDependencies, 'dependency', `workspace ${path} peerDependencies`),
  )
  const development = dependencyEntries(workspace.devDependencies, 'dev', `workspace ${path} devDependencies`)
  const grouped = new Map<DependencyRole, Array<{ name: string; range: string; kind: DependencyKind }>>()

  if (production.length > 0) {
    grouped.set(productionRole(path), production)
  }
  if (development.length > 0) {
    const role = developmentRole(path)
    grouped.set(role, mergeDependencyEntries(grouped.get(role) ?? [], development))
  }
  if (grouped.size === 0) {
    grouped.set(path === 'docs' ? 'build' : 'not-applicable', [])
  }

  return [...grouped.entries()].map(([role, dependencies]) => ({
    ref: rootRef(source, path),
    name,
    path,
    role,
    dependencies,
  }))
}

function comparePaths(a: string[], b: string[]): number {
  return a.join('\0').localeCompare(b.join('\0'))
}

function sortGraph(graph: DependencyGraph): DependencyGraph {
  graph.roots.sort((a, b) =>
    a.ref.localeCompare(b.ref)
    || roleImpact(b.role) - roleImpact(a.role)
    || JSON.stringify(a.dependencies).localeCompare(JSON.stringify(b.dependencies)),
  )
  graph.nodes.sort((a, b) => a.ref.localeCompare(b.ref))
  graph.edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
  for (const node of graph.nodes) {
    node.roles.sort((a, b) => roleImpact(b) - roleImpact(a))
    node.paths.sort(comparePaths)
  }
  return graph
}

function dedupeEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function propagateRoles(nodes: PackageNode[], edges: DependencyEdge[], seeds: RootSeed[]): void {
  const nodesByRef = new Map(nodes.map((node) => [node.ref, node]))
  const adjacency = new Map<string, DependencyEdge[]>()
  for (const edge of edges) {
    if (!nodesByRef.has(edge.from) || !nodesByRef.has(edge.to)) continue
    const existing = adjacency.get(edge.from) ?? []
    existing.push(edge)
    adjacency.set(edge.from, existing)
  }
  for (const values of adjacency.values()) {
    values.sort((a, b) => a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
  }

  const pathKeys = new Map<string, Set<string>>()
  const expansionKeys = new Map<string, Set<string>>()
  for (const { root, targets } of seeds) {
    const queue: Array<{ ref: string; path: string[] }> = []
    for (const target of targets.sort((a, b) => a.ref.localeCompare(b.ref) || a.kind.localeCompare(b.kind))) {
      if (nodesByRef.has(target.ref)) {
        queue.push({ ref: target.ref, path: [root.ref, target.ref] })
      }
    }

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index]
      const node = nodesByRef.get(item.ref)
      if (!node) continue
      const pathKey = item.path.join('\0')
      const nodePathKeys = pathKeys.get(node.ref) ?? new Set<string>()
      if (!nodePathKeys.has(pathKey)) {
        nodePathKeys.add(pathKey)
        pathKeys.set(node.ref, nodePathKeys)
        node.paths.push(item.path)
      }
      if (!node.roles.includes(root.role)) node.roles.push(root.role)

      const expansionKey = `${root.role}\0${pathKey}`
      const nodeExpansionKeys = expansionKeys.get(node.ref) ?? new Set<string>()
      if (nodeExpansionKeys.has(expansionKey)) continue
      nodeExpansionKeys.add(expansionKey)
      expansionKeys.set(node.ref, nodeExpansionKeys)

      for (const edge of adjacency.get(item.ref) ?? []) {
        if (item.path.includes(edge.to)) continue
        queue.push({ ref: edge.to, path: [...item.path, edge.to] })
      }
    }
  }
}

function parentBunLockKey(lockKey: string): string | null {
  const parts = lockKey.split('/')
  if (parts.length === 1) return null
  const remove = parts.length >= 2 && parts.at(-2)?.startsWith('@') ? 2 : 1
  const parent = parts.slice(0, -remove).join('/')
  return parent || null
}

function bunCandidates(parentLockKey: string | null, dependencyName: string): string[] {
  const candidates: string[] = []
  let cursor = parentLockKey
  while (cursor) {
    candidates.push(`${cursor}/${dependencyName}`)
    cursor = parentBunLockKey(cursor)
  }
  candidates.push(dependencyName)
  return [...new Set(candidates)]
}

function npmPackageName(packagePath: string): string {
  const marker = 'node_modules/'
  const index = packagePath.lastIndexOf(marker)
  if (index < 0) {
    throw new Error(`malformed npm package path: ${packagePath}`)
  }
  const name = packagePath.slice(index + marker.length)
  if (name.length === 0 || (name.startsWith('@') && !/^@[^/]+\/[^/]+$/.test(name)) || (!name.startsWith('@') && name.includes('/'))) {
    throw new Error(`malformed npm package name at ${packagePath}`)
  }
  return name
}

function npmCandidates(parentPath: string | null, dependencyName: string): string[] {
  const candidates: string[] = []
  let cursor = parentPath ?? ''
  for (;;) {
    candidates.push(`${cursor ? `${cursor}/` : ''}node_modules/${dependencyName}`)
    if (cursor.length === 0) break
    const marker = cursor.lastIndexOf('/node_modules/')
    cursor = marker >= 0 ? cursor.slice(0, marker) : ''
  }
  return [...new Set(candidates)]
}

export async function discoverSupportedLocks(repositoryRoot: string): Promise<Array<{ source: LockSourceId; path: string }>> {
  const root = resolve(repositoryRoot)
  const expected = new Map<string, LockSourceId>([
    [join(root, 'bun.lock'), 'bun-workspaces'],
    [join(root, 'tools/hapi-codex-sync/package-lock.json'), 'hapi-codex-sync'],
  ])
  const found: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if ((entry.isFile() || entry.isSymbolicLink()) && LOCK_NAMES.has(entry.name)) {
        found.push(path)
      }
    }
  }

  await walk(root)
  for (const path of found) {
    if (!expected.has(path)) {
      throw new Error(`unexpected lockfile ${lockRelative(root, path)}`)
    }
  }
  for (const path of expected.keys()) {
    if (!found.includes(path)) {
      throw new Error(`missing required lockfile ${lockRelative(root, path)}`)
    }
  }

  return [...expected.entries()]
    .map(([path, source]) => ({ source, path }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function parseBunLockGraph(lockPath: string): Promise<DependencyGraph> {
  const absoluteLockPath = resolve(lockPath)
  const content = await Bun.file(absoluteLockPath).text()
  let parsed: unknown
  try {
    const bunWithJsonc = Bun as typeof Bun & { JSONC: { parse(input: string): unknown } }
    parsed = bunWithJsonc.JSONC.parse(content)
  } catch (error) {
    throw new Error(`invalid Bun JSONC lockfile: ${error instanceof Error ? error.message : String(error)}`)
  }
  const lock = requireRecord(parsed, 'Bun lockfile')
  if (lock.lockfileVersion !== 1) {
    throw new Error(`unsupported Bun lockfileVersion: ${String(lock.lockfileVersion)}`)
  }
  if (lock.configVersion !== 1) {
    throw new Error(`unsupported Bun configVersion: ${String(lock.configVersion)}`)
  }
  const workspaces = requireRecord(lock.workspaces, 'Bun workspaces')
  const packages = requireRecord(lock.packages, 'Bun packages')
  const source: LockSourceId = 'bun-workspaces'
  const roots = Object.entries(workspaces).flatMap(([path, workspace]) =>
    rootGroups(source, path, requireRecord(workspace, `workspace ${path || '.'}`)),
  )

  const nodes: PackageNode[] = []
  const nodesByLockKey = new Map<string, PackageNode>()
  const workspaceTargets = new Map<string, string>()
  const workspaceLockKeyByPath = new Map<string, string>()
  const metadataByLockKey = new Map<string, UnknownRecord>()
  const optionalPeersByLockKey = new Map<string, Set<string>>()

  for (const [lockKey, rawTuple] of Object.entries(packages)) {
    if (!Array.isArray(rawTuple)) {
      throw new Error(`malformed Bun package tuple for ${lockKey}`)
    }
    if (rawTuple.length === 1) {
      const identity = requireString(rawTuple[0], `${lockKey} workspace identity`)
      const marker = identity.lastIndexOf('@workspace:')
      if (marker <= 0) {
        throw new Error(`malformed Bun workspace record for ${lockKey}`)
      }
      const workspaceName = identity.slice(0, marker)
      const workspacePath = identity.slice(marker + '@workspace:'.length) || '.'
      const workspace = workspaces[workspacePath === '.' ? '' : workspacePath]
      if (!isRecord(workspace) || workspace.name !== workspaceName) {
        throw new Error(`Bun workspace record does not resolve for ${lockKey}`)
      }
      workspaceTargets.set(lockKey, rootRef(source, workspacePath))
      workspaceLockKeyByPath.set(workspacePath, lockKey)
      continue
    }
    if (rawTuple.length !== 4 || typeof rawTuple[1] !== 'string') {
      throw new Error(`malformed Bun package tuple for ${lockKey}`)
    }
    const { name, version } = packageIdentity(rawTuple[0], lockKey)
    const metadata = requireRecord(rawTuple[2], `${lockKey} metadata`)
    const packageIntegrity = integrity(rawTuple[3], lockKey)
    const optionalPeers = stringList(metadata.optionalPeers, `${lockKey} optionalPeers`)
    const node: PackageNode = {
      ref: `${source}:${lockKey}`,
      lockSource: source,
      lockKey,
      name,
      version,
      integrity: packageIntegrity,
      purl: npmPurl(name, version),
      platform: platformConstraint(metadata, lockKey),
      roles: [],
      paths: [],
    }
    nodes.push(node)
    nodesByLockKey.set(lockKey, node)
    metadataByLockKey.set(lockKey, metadata)
    optionalPeersByLockKey.set(lockKey, new Set(optionalPeers))
  }

  const resolveTarget = (parentLockKey: string | null, dependencyName: string): string | null => {
    for (const candidate of bunCandidates(parentLockKey, dependencyName)) {
      const node = nodesByLockKey.get(candidate)
      if (node) return node.ref
      const workspace = workspaceTargets.get(candidate)
      if (workspace) return workspace
    }
    return null
  }

  const edges: DependencyEdge[] = []
  const seeds: RootSeed[] = []
  for (const root of roots) {
    const targets: RootSeed['targets'] = []
    const workspaceParent = workspaceLockKeyByPath.get(root.path) ?? null
    for (const dependency of root.dependencies) {
      const target = resolveTarget(workspaceParent, dependency.name)
      if (!target) {
        throw new Error(`unresolved required dependency ${dependency.name} from ${root.ref}`)
      }
      edges.push({ from: root.ref, to: target, kind: dependency.kind })
      targets.push({ ref: target, kind: dependency.kind })
    }
    seeds.push({ root, targets })
  }

  for (const [lockKey, node] of nodesByLockKey) {
    const metadata = metadataByLockKey.get(lockKey)!
    const optionalPeers = optionalPeersByLockKey.get(lockKey)!
    const dependencies = mergeDependencyEntries(
      dependencyEntries(metadata.dependencies, 'dependency', `${lockKey} dependencies`),
      dependencyEntries(metadata.optionalDependencies, 'optional', `${lockKey} optionalDependencies`),
      dependencyEntries(metadata.peerDependencies, 'dependency', `${lockKey} peerDependencies`),
    )
    for (const dependency of dependencies) {
      const target = resolveTarget(lockKey, dependency.name)
      if (!target) {
        if (optionalPeers.has(dependency.name)) continue
        throw new Error(`unresolved required dependency ${dependency.name} from ${node.ref}`)
      }
      edges.push({ from: node.ref, to: target, kind: dependency.kind })
    }
  }

  const graph: DependencyGraph = {
    source,
    lockPath: absoluteLockPath,
    lockSha256: sha256(content),
    roots,
    nodes,
    edges: dedupeEdges(edges),
  }
  propagateRoles(graph.nodes, graph.edges, seeds)
  for (const node of graph.nodes) {
    if (node.paths.length === 0) {
      node.roles.push('not-applicable')
    }
  }
  return sortGraph(graph)
}

export async function parseNpmLockGraph(lockPath: string): Promise<DependencyGraph> {
  const absoluteLockPath = resolve(lockPath)
  const content = await Bun.file(absoluteLockPath).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`invalid npm lockfile JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const lock = requireRecord(parsed, 'npm lockfile')
  if (lock.lockfileVersion !== 3) {
    throw new Error(`unsupported npm lockfileVersion: ${String(lock.lockfileVersion)}`)
  }
  const packages = requireRecord(lock.packages, 'npm packages')
  const source: LockSourceId = 'hapi-codex-sync'
  const rootPackage = requireRecord(packages[''], 'npm root package')
  const rootWorkspacePath = 'tools/hapi-codex-sync'
  const roots = rootGroups(source, rootWorkspacePath, rootPackage)

  const nodes: PackageNode[] = []
  const nodesByPath = new Map<string, PackageNode>()
  const metadataByPath = new Map<string, UnknownRecord>()

  for (const [packagePath, rawMetadata] of Object.entries(packages)) {
    if (packagePath === '') continue
    const metadata = requireRecord(rawMetadata, `npm package ${packagePath}`)
    if (metadata.link === true) {
      throw new Error(`unsupported npm link package ${packagePath}`)
    }
    const name = npmPackageName(packagePath)
    const version = requireString(metadata.version, `${packagePath} version`)
    assertSemver(version, packagePath)
    const packageIntegrity = integrity(metadata.integrity, packagePath)
    const node: PackageNode = {
      ref: `${source}:${packagePath}`,
      lockSource: source,
      lockKey: packagePath,
      name,
      version,
      integrity: packageIntegrity,
      purl: npmPurl(name, version),
      platform: platformConstraint(metadata, packagePath),
      roles: [],
      paths: [],
    }
    nodes.push(node)
    nodesByPath.set(packagePath, node)
    metadataByPath.set(packagePath, metadata)
  }

  const resolveTarget = (parentPath: string | null, dependencyName: string): string | null => {
    for (const candidate of npmCandidates(parentPath, dependencyName)) {
      const node = nodesByPath.get(candidate)
      if (node) return node.ref
    }
    return null
  }

  const edges: DependencyEdge[] = []
  const seeds: RootSeed[] = []
  for (const root of roots) {
    const targets: RootSeed['targets'] = []
    for (const dependency of root.dependencies) {
      const target = resolveTarget(null, dependency.name)
      if (!target) {
        throw new Error(`unresolved required dependency ${dependency.name} from ${root.ref}`)
      }
      edges.push({ from: root.ref, to: target, kind: dependency.kind })
      targets.push({ ref: target, kind: dependency.kind })
    }
    seeds.push({ root, targets })
  }

  for (const [packagePath, node] of nodesByPath) {
    const metadata = metadataByPath.get(packagePath)!
    const peerMeta = metadata.peerDependenciesMeta === undefined
      ? {}
      : requireRecord(metadata.peerDependenciesMeta, `${packagePath} peerDependenciesMeta`)
    const dependencies = mergeDependencyEntries(
      dependencyEntries(metadata.dependencies, 'dependency', `${packagePath} dependencies`),
      dependencyEntries(metadata.optionalDependencies, 'optional', `${packagePath} optionalDependencies`),
      dependencyEntries(metadata.peerDependencies, 'dependency', `${packagePath} peerDependencies`),
    )
    for (const dependency of dependencies) {
      const target = resolveTarget(packagePath, dependency.name)
      if (!target) {
        const peer = peerMeta[dependency.name]
        if (isRecord(peer) && peer.optional === true) continue
        throw new Error(`unresolved required dependency ${dependency.name} from ${node.ref}`)
      }
      edges.push({ from: node.ref, to: target, kind: dependency.kind })
    }
  }

  const graph: DependencyGraph = {
    source,
    lockPath: absoluteLockPath,
    lockSha256: sha256(content),
    roots,
    nodes,
    edges: dedupeEdges(edges),
  }
  propagateRoles(graph.nodes, graph.edges, seeds)
  for (const node of graph.nodes) {
    if (node.paths.length === 0) {
      node.roles.push('not-applicable')
    }
  }
  return sortGraph(graph)
}

export async function loadRepositoryGraphs(repositoryRoot: string): Promise<DependencyGraph[]> {
  const locks = await discoverSupportedLocks(repositoryRoot)
  return Promise.all(locks.map(({ source, path }) =>
    source === 'bun-workspaces' ? parseBunLockGraph(path) : parseNpmLockGraph(path),
  ))
}
