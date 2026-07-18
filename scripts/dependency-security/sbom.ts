import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { DependencyGraph, DependencyRole, PackageNode } from './model'
import { parsePolicy } from './policy'

export type SbomOptions = {
  graphs: DependencyGraph[]
  policyPath: string
  gitSha: string
  outputDirectory: string
}
export type SbomResult = {
  bunPath: string
  npmPath: string
  manifestPath: string
  hashes: Record<string, string>
}

type Scope = 'shipped' | 'not-shipped-with-cli'
type Property = { name: string; value: string }
type ComponentAccumulator = {
  bomRef: string
  name: string
  version: string
  purl: string
  integrityHex: string
  lockKeys: Set<string>
  roles: Set<DependencyRole>
  origins: Set<string>
  os: Set<string>
  cpu: Set<string>
}

const SCHEMA_DIRECTORY = resolve(import.meta.dir, '../../security/dependencies/schemas')
const OFFICIAL_SCHEMA_HASHES: Record<string, string> = {
  'bom-1.6.schema.json': '3e92dddbc30cf7f6a02b80f0942b1a4cfd4fb1c26f1dfc4310afa9d613cafb93',
  'jsf-0.82.schema.json': '8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae',
  'spdx.schema.json': 'baa9d3bd1ed57b6751b0887edead6b5063ff53ff7429cf85d476c6c94af0166e',
}
const DEPENDENCY_GATE_FILES = new Set([
  'bun-audit-production.json',
  'bun-audit-production.status',
  'bun-audit-production.stderr',
  'dependency-affected-instances.json',
  'dependency-audit-summary.json',
  'dependency-audit-summary.txt',
  'dependency-gate-metadata.json',
  'npm-audit-production.json',
  'npm-audit-production.status',
  'npm-audit-production.stderr',
])

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

async function verifySbomOutputDirectory(outputDirectory: string): Promise<void> {
  const entries = await readdir(outputDirectory, { withFileTypes: true })
  if (entries.length === 0) return

  const unexpected = entries
    .filter((entry) => !entry.isFile() || !DEPENDENCY_GATE_FILES.has(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`SBOM output directory has unexpected pre-existing entries: ${unexpected.join(', ')}`)
  }

  let summary: unknown
  try {
    summary = JSON.parse(await readFile(join(outputDirectory, 'dependency-audit-summary.json'), 'utf8'))
  } catch {
    throw new Error('SBOM co-location requires a successful dependency gate receipt')
  }
  if (typeof summary !== 'object' || summary === null || (summary as { ok?: unknown }).ok !== true) {
    throw new Error('SBOM co-location requires a successful dependency gate receipt')
  }
}

function sortedProperties(values: Array<[string, Iterable<string>]>): Property[] {
  const properties: Property[] = []
  for (const [name, entries] of values) {
    for (const value of [...new Set(entries)].sort()) properties.push({ name, value })
  }
  return properties.sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
}

function normalizedIntegrity(node: PackageNode): { canonical: string; hex: string } {
  if (!node.integrity?.startsWith('sha512-')) {
    throw new Error(`SBOM package ${node.ref} has no SHA-512 registry integrity`)
  }
  const encoded = node.integrity.slice('sha512-'.length)
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`SBOM package ${node.ref} has malformed SHA-512 integrity`)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new Error(`SBOM package ${node.ref} has non-canonical SHA-512 integrity`)
  }
  return { canonical: `sha512-${encoded}`, hex: bytes.toString('hex').toLowerCase() }
}

function workspaceOrigin(graph: DependencyGraph, path: string[]): string {
  const prefix = `${graph.source}:workspace:`
  if (path.length < 2 || !path[0].startsWith(prefix)) {
    throw new Error(`SBOM dependency path is malformed: ${path.join(' -> ')}`)
  }
  return path[0].slice(prefix.length)
}

function splitPackageName(name: string): { group?: string; name: string } {
  if (!name.startsWith('@')) return { name }
  const slash = name.indexOf('/')
  if (slash <= 1 || slash === name.length - 1) throw new Error(`malformed scoped package ${name}`)
  return { group: name.slice(0, slash), name: name.slice(slash + 1) }
}

function repositoryComponent(graph: DependencyGraph, gitSha: string, scope: Scope): Record<string, unknown> {
  return {
    type: 'application',
    'bom-ref': `urn:hapi:repository:${graph.source}`,
    name: graph.source === 'bun-workspaces' ? 'hapi' : 'hapi-codex-sync',
    version: gitSha,
    properties: sortedProperties([
      ['hapi:distribution-scope', [scope]],
      ['hapi:lock-source', [graph.source]],
    ]),
  }
}

export function buildCycloneDx(graph: DependencyGraph, gitSha: string, scope: Scope): unknown {
  if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('SBOM Git SHA must be exactly 40 lowercase hexadecimal characters')
  if (
    (graph.source === 'bun-workspaces' && scope !== 'shipped')
    || (graph.source === 'hapi-codex-sync' && scope !== 'not-shipped-with-cli')
  ) {
    throw new Error(`SBOM scope ${scope} does not match ${graph.source}`)
  }

  const refMap = new Map<string, string>()
  const workspaceComponents = new Map<string, {
    bomRef: string
    name: string
    path: string
    roles: Set<DependencyRole>
  }>()
  for (const root of graph.roots) {
    const bomRef = `urn:hapi:workspace:${root.path}`
    const existing = workspaceComponents.get(root.path)
    if (existing && existing.name !== root.name) throw new Error(`workspace ${root.path} has conflicting names`)
    const workspace = existing ?? { bomRef, name: root.name, path: root.path, roles: new Set<DependencyRole>() }
    workspace.roles.add(root.role)
    workspaceComponents.set(root.path, workspace)
    refMap.set(root.ref, bomRef)
  }

  const libraries = new Map<string, ComponentAccumulator>()
  for (const node of graph.nodes) {
    const integrity = normalizedIntegrity(node)
    const key = `${graph.source}\0${node.purl}\0${integrity.canonical}`
    const bomRef = `urn:hapi:component:${sha256(key)}`
    const existing = libraries.get(key)
    if (
      existing
      && (existing.name !== node.name || existing.version !== node.version || existing.purl !== node.purl || existing.integrityHex !== integrity.hex)
    ) {
      throw new Error(`merged SBOM component identity conflicts for ${node.ref}`)
    }
    const component = existing ?? {
      bomRef,
      name: node.name,
      version: node.version,
      purl: node.purl,
      integrityHex: integrity.hex,
      lockKeys: new Set<string>(),
      roles: new Set<DependencyRole>(),
      origins: new Set<string>(),
      os: new Set<string>(),
      cpu: new Set<string>(),
    }
    component.lockKeys.add(node.lockKey)
    node.roles.forEach((role) => component.roles.add(role))
    node.paths.forEach((path) => component.origins.add(workspaceOrigin(graph, path)))
    node.platform?.os.forEach((value) => component.os.add(value))
    node.platform?.cpu.forEach((value) => component.cpu.add(value))
    libraries.set(key, component)
    refMap.set(node.ref, bomRef)
  }

  const components: Array<Record<string, unknown>> = []
  for (const workspace of workspaceComponents.values()) {
    components.push({
      type: workspace.path === 'shared' ? 'library' : 'application',
      'bom-ref': workspace.bomRef,
      name: workspace.name,
      properties: sortedProperties([
        ['hapi:distribution-scope', [scope]],
        ['hapi:role', workspace.roles],
        ['hapi:workspace-path', [workspace.path]],
      ]),
    })
  }
  for (const library of libraries.values()) {
    const packageName = splitPackageName(library.name)
    components.push({
      type: 'library',
      'bom-ref': library.bomRef,
      ...(packageName.group === undefined ? {} : { group: packageName.group }),
      name: packageName.name,
      version: library.version,
      hashes: [{ alg: 'SHA-512', content: library.integrityHex }],
      purl: library.purl,
      properties: sortedProperties([
        ['hapi:lock-key', library.lockKeys],
        ['hapi:lock-source', [graph.source]],
        ['hapi:platform-cpu', library.cpu],
        ['hapi:platform-os', library.os],
        ['hapi:role', library.roles],
        ['hapi:workspace-origin', library.origins],
      ]),
    })
  }
  components.sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref'])))

  const repositoryRef = `urn:hapi:repository:${graph.source}`
  const dependencies = new Map<string, Set<string>>([[repositoryRef, new Set()]])
  for (const component of components) dependencies.set(String(component['bom-ref']), new Set())
  for (const workspace of workspaceComponents.values()) dependencies.get(repositoryRef)!.add(workspace.bomRef)
  for (const edge of graph.edges) {
    const from = refMap.get(edge.from)
    const to = refMap.get(edge.to)
    if (!from || !to) throw new Error(`SBOM edge contains an unknown ref: ${edge.from} -> ${edge.to}`)
    if (from !== to) dependencies.get(from)!.add(to)
  }
  const dependencyList = [...dependencies.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref))

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: { component: repositoryComponent(graph, gitSha, scope) },
    components,
    dependencies: dependencyList,
  }
}

export function validateCycloneDx(document: unknown, schemaDirectory: string): void {
  const bomSchema = JSON.parse(readFileSync(join(schemaDirectory, 'bom-1.6.schema.json'), 'utf8'))
  const spdxSchema = JSON.parse(readFileSync(join(schemaDirectory, 'spdx.schema.json'), 'utf8'))
  const jsfSchema = JSON.parse(readFileSync(join(schemaDirectory, 'jsf-0.82.schema.json'), 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  // Existing parents can retain another compatible Ajv 8 instance in bun.lock;
  // ajv-formats' public installer contract is stable across those 8.x copies.
  const installFormats = addFormats as unknown as (instance: Ajv) => Ajv
  installFormats(ajv)
  ajv.addFormat('iri-reference', {
    type: 'string',
    validate: (value: string) => !/[\u0000-\u0020<>"{}|\\^`]/u.test(value),
  })
  ajv.addFormat('idn-email', {
    type: 'string',
    validate: (value: string) => /^[^\s@]+@[^\s@]+$/u.test(value),
  })
  ajv.addSchema(spdxSchema)
  ajv.addSchema(jsfSchema)
  const validate = ajv.compile(bomSchema)
  if (!validate(document)) {
    throw new Error(`CycloneDX 1.6 schema validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`)
  }
}

function componentCount(document: unknown): number {
  const value = document as { components?: unknown[] }
  return Array.isArray(value.components) ? value.components.length : 0
}

function edgeCount(document: unknown): number {
  const value = document as { dependencies?: Array<{ dependsOn?: unknown[] }> }
  return Array.isArray(value.dependencies)
    ? value.dependencies.reduce((total, dependency) => total + (Array.isArray(dependency.dependsOn) ? dependency.dependsOn.length : 0), 0)
    : 0
}

export async function writeSboms(options: SbomOptions): Promise<SbomResult> {
  if (!/^[a-f0-9]{40}$/.test(options.gitSha)) throw new Error('SBOM Git SHA must be exactly 40 lowercase hexadecimal characters')
  const graphBySource = new Map(options.graphs.map((graph) => [graph.source, graph]))
  const bunGraph = graphBySource.get('bun-workspaces')
  const npmGraph = graphBySource.get('hapi-codex-sync')
  if (!bunGraph || !npmGraph || graphBySource.size !== 2) throw new Error('SBOM requires exactly the two supported dependency graphs')

  const policyPath = isAbsolute(options.policyPath) ? options.policyPath : resolve(options.policyPath)
  const policyBytes = await readFile(policyPath)
  const policy = parsePolicy(JSON.parse(new TextDecoder().decode(policyBytes)))
  if (
    policy.currentLocks['bun-workspaces'] !== bunGraph.lockSha256
    || policy.currentLocks['hapi-codex-sync'] !== npmGraph.lockSha256
  ) {
    throw new Error('SBOM graph lock hashes do not match the dependency policy')
  }

  const schemaHashes: Record<string, string> = {}
  for (const [filename, expectedHash] of Object.entries(OFFICIAL_SCHEMA_HASHES)) {
    const actualHash = sha256(await readFile(join(SCHEMA_DIRECTORY, filename)))
    if (actualHash !== expectedHash) throw new Error(`vendored schema hash drift for ${filename}`)
    schemaHashes[filename] = actualHash
  }

  const bunDocument = buildCycloneDx(bunGraph, options.gitSha, 'shipped')
  const npmDocument = buildCycloneDx(npmGraph, options.gitSha, 'not-shipped-with-cli')
  validateCycloneDx(bunDocument, SCHEMA_DIRECTORY)
  validateCycloneDx(npmDocument, SCHEMA_DIRECTORY)
  const bunBytes = stableJson(bunDocument)
  const npmBytes = stableJson(npmDocument)
  const bunHash = sha256(bunBytes)
  const npmHash = sha256(npmBytes)
  const manifest = {
    schemaVersion: 1,
    generatorSchemaVersion: 1,
    gitSha: options.gitSha,
    packageManagers: policy.packageManagers,
    locks: {
      'bun-workspaces': bunGraph.lockSha256,
      'hapi-codex-sync': npmGraph.lockSha256,
    },
    policySha256: sha256(policyBytes),
    schemas: schemaHashes,
    sboms: {
      'hapi.cdx.json': {
        sha256: bunHash,
        components: componentCount(bunDocument),
        dependencyEdges: edgeCount(bunDocument),
      },
      'hapi-codex-sync.cdx.json': {
        sha256: npmHash,
        components: componentCount(npmDocument),
        dependencyEdges: edgeCount(npmDocument),
      },
    },
  }
  const manifestBytes = stableJson(manifest)

  const outputDirectory = isAbsolute(options.outputDirectory) ? options.outputDirectory : resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  await verifySbomOutputDirectory(outputDirectory)
  const bunPath = join(outputDirectory, 'hapi.cdx.json')
  const npmPath = join(outputDirectory, 'hapi-codex-sync.cdx.json')
  const manifestPath = join(outputDirectory, 'hapi-sbom-manifest.json')
  await Promise.all([
    writeFile(bunPath, bunBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(npmPath, npmBytes, { flag: 'wx', mode: 0o600 }),
    writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o600 }),
  ])
  return {
    bunPath,
    npmPath,
    manifestPath,
    hashes: {
      'hapi-sbom-manifest.json': sha256(manifestBytes),
      'hapi-codex-sync.cdx.json': npmHash,
      'hapi.cdx.json': bunHash,
    },
  }
}
