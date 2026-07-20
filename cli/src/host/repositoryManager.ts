import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
    GitCapabilities,
    GitBranch,
    GitCommitTemplate,
    GitFileChange,
    GitOperation,
    GitRemote,
    RepositorySnapshot
} from '@hapi/protocol'
import type { HostOperationContext } from './hostOperationManager'
import { WorkspaceScope } from './workspaceScope'
import { configuration } from '@/configuration'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 1024 * 1024

type CommandResult = { stdout: string; stderr: string }
type GitPreferenceDocument = {
    version: 1
    repositories: Record<string, GitCommitTemplate>
}

function emptyPreferences(): GitPreferenceDocument {
    return { version: 1, repositories: {} }
}

function redact(value: string): string {
    return value
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
        .replace(/([?&](?:access_token|private_token|api_?key|key|secret|password|passwd)=)[^&#\s]+/gi, '$1***')
}

function isGitHubShorthand(source: string): boolean {
    const parts = source.replace(/\.git$/, '').split('/')
    return parts.length === 2
        && parts.every((part) => part !== '.' && part !== '..' && /^[\w.-]+$/.test(part))
}

function isGitHubSource(source: string): boolean {
    return isGitHubShorthand(source)
        || /(?:^|[.@/:])github\.com(?:[/:]|$)/i.test(source)
}

function gitFallbackSource(source: string): string {
    return isGitHubShorthand(source)
        ? `https://github.com/${source.replace(/\.git$/, '')}.git`
        : source
}

function isLocalGitSource(source: string): boolean {
    if (/^file:/i.test(source) || isAbsolute(source) || /^\.\.?([\\/]|$)/.test(source)) return true
    if (isGitHubSource(source)) return false
    const colon = source.indexOf(':')
    const separator = source.search(/[\\/]/)
    return colon < 0 || (separator >= 0 && separator < colon)
}

function assertSafeRemoteUrl(url: string): void {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url)
        || /[?&](?:access_token|private_token|api_?key|key|secret|password|passwd)=/i.test(url)) {
        throw new Error('Remote URLs containing inline credentials are not allowed')
    }
    if (/\s/.test(url) || url.startsWith('-')) {
        throw new Error('Invalid remote URL')
    }
}

function parseStatus(stdout: string): Pick<RepositorySnapshot, 'branch' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
    let branch: string | null = null
    let upstream: string | null = null
    let ahead = 0
    let behind = 0
    const changes: GitFileChange[] = []
    const records = stdout.split('\0')

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        if (!record) continue
        if (record.startsWith('# branch.head ')) {
            const value = record.slice('# branch.head '.length)
            branch = value === '(detached)' ? null : value
            continue
        }
        if (record.startsWith('# branch.upstream ')) {
            upstream = record.slice('# branch.upstream '.length)
            continue
        }
        if (record.startsWith('# branch.ab ')) {
            const match = /\+(\d+) -(\d+)/.exec(record)
            if (match) {
                ahead = Number(match[1])
                behind = Number(match[2])
            }
            continue
        }
        const kind = record[0]
        if (kind === '?' || kind === '!') {
            if (kind === '?') {
                changes.push({ path: record.slice(2), indexStatus: '?', worktreeStatus: '?' })
            }
            continue
        }
        const fields = record.split(' ')
        if (kind === '1' && fields.length >= 9) {
            const xy = fields[1]
            changes.push({ path: fields.slice(8).join(' '), indexStatus: xy[0], worktreeStatus: xy[1] })
        } else if (kind === '2' && fields.length >= 10) {
            const xy = fields[1]
            const oldPath = records[index + 1]
            index += 1
            changes.push({
                path: fields.slice(9).join(' '),
                ...(oldPath ? { oldPath } : {}),
                indexStatus: xy[0],
                worktreeStatus: xy[1]
            })
        } else if (kind === 'u' && fields.length >= 11) {
            changes.push({ path: fields.slice(10).join(' '), indexStatus: 'U', worktreeStatus: 'U' })
        }
    }
    return { branch, upstream, ahead, behind, changes }
}

function parseRemotes(stdout: string): GitRemote[] {
    const byName = new Map<string, GitRemote>()
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/.exec(line)
        if (!match) continue
        const current = byName.get(match[1]) ?? { name: match[1] }
        if (match[3] === 'fetch') current.fetchUrl = redact(match[2])
        else current.pushUrl = redact(match[2])
        byName.set(match[1], current)
    }
    return [...byName.values()]
}

function parseBranches(stdout: string, mergedOutput: string): GitBranch[] {
    const merged = new Set(mergedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
    const branches: GitBranch[] = []
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        const [ref, fullName, upstream, head] = line.split('\t')
        if (!ref || !fullName) continue
        if (ref.startsWith('refs/remotes/')) {
            const remoteRef = ref.slice('refs/remotes/'.length)
            const slash = remoteRef.indexOf('/')
            if (slash <= 0) continue
            const remote = remoteRef.slice(0, slash)
            const name = remoteRef.slice(slash + 1)
            if (name === 'HEAD') continue
            branches.push({ name, remote })
            continue
        }
        branches.push({
            name: fullName,
            ...(head === '*' ? { current: true } : {}),
            ...(upstream ? { upstream } : {}),
            ...(merged.has(fullName) ? { merged: true } : {})
        })
    }
    return branches.sort((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1
        if (Boolean(left.remote) !== Boolean(right.remote)) return left.remote ? 1 : -1
        return `${left.remote ?? ''}/${left.name}`.localeCompare(`${right.remote ?? ''}/${right.name}`)
    })
}

export class RepositoryManager {
    private capabilitiesPromise: Promise<GitCapabilities> | null = null
    private capabilitiesExpiresAt = 0
    private readonly preferencePath: string
    private preferenceUpdate = Promise.resolve()

    constructor(scope: WorkspaceScope, options?: { preferencePath?: string }) {
        this.scope = scope
        this.preferencePath = options?.preferencePath ?? join(configuration.happyHomeDir, 'git-preferences.json')
    }

    private readonly scope: WorkspaceScope

    async capabilities(refresh = false): Promise<GitCapabilities> {
        if (!this.capabilitiesPromise || refresh || Date.now() >= this.capabilitiesExpiresAt) {
            this.capabilitiesPromise = (async () => {
                const [gitAvailable, ghAvailable] = await Promise.all([
                    this.commandAvailable('git', ['--version'], undefined, 2_000),
                    this.commandAvailable('gh', ['--version'], undefined, 2_000)
                ])
                const ghAuthenticated = ghAvailable && await this.commandAvailable('gh', ['auth', 'status'], undefined, 3_000)
                return { gitAvailable, ghAvailable, ghAuthenticated }
            })()
            this.capabilitiesExpiresAt = Date.now() + 30_000
        }
        return await this.capabilitiesPromise
    }

    async inspect(path: string): Promise<RepositorySnapshot> {
        const cwd = await this.scope.resolveReadable(path)
        const capabilities = await this.capabilities()
        if (!capabilities.gitAvailable) throw new Error('Git is not installed')
        const rootResult = await this.run('git', ['rev-parse', '--show-toplevel'], cwd)
        const repositoryRoot = await this.scope.resolveReadable(rootResult.stdout.trim())
        const [statusResult, remoteResult, branchResult, mergedResult, commitTemplate] = await Promise.all([
            this.run('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], repositoryRoot),
            this.run('git', ['remote', '-v'], repositoryRoot),
            this.run('git', ['for-each-ref', '--format=%(refname)\t%(refname:short)\t%(upstream:short)\t%(HEAD)', 'refs/heads', 'refs/remotes'], repositoryRoot),
            this.run('git', ['branch', '--format=%(refname:short)', '--merged'], repositoryRoot).catch(() => ({ stdout: '', stderr: '' })),
            this.getCommitTemplate(repositoryRoot)
        ])
        return {
            repositoryRoot,
            ...parseStatus(statusResult.stdout),
            remotes: parseRemotes(remoteResult.stdout),
            branches: parseBranches(branchResult.stdout, mergedResult.stdout),
            commitTemplate,
            capabilities
        }
    }

    async lockKeys(operation: GitOperation): Promise<string[]> {
        if (operation.kind === 'clone') {
            const destination = await this.scope.resolveDestination(operation.destination)
            const parent = await this.scope.resolveReadable(dirname(destination))
            await this.resolveGitSource(operation.source, parent)
            return [destination]
        }
        const repository = (await this.inspect(operation.repository)).repositoryRoot
        if (operation.kind === 'set-remote') await this.resolveGitSource(operation.url, repository)
        return [repository]
    }

    async execute(operation: GitOperation, context: HostOperationContext): Promise<Record<string, unknown>> {
        if (operation.kind === 'clone') {
            const destination = await this.scope.resolveDestination(operation.destination)
            const parent = await this.scope.resolveReadable(dirname(destination))
            const source = await this.resolveGitSource(operation.source, parent)
            const capabilities = await this.capabilities(true)
            if (!capabilities.gitAvailable) throw new Error('Git is not installed')
            context.report(0.1, 'Cloning repository')
            if (!source.local && isGitHubSource(source.value) && capabilities.ghAvailable && capabilities.ghAuthenticated) {
                await this.run('gh', ['repo', 'clone', source.value, destination], parent, context.signal, 10 * 60_000)
                return { repository: destination, tool: 'gh' }
            }
            await this.run('git', ['clone', '--', source.local ? source.value : gitFallbackSource(source.value), destination], parent, context.signal, 10 * 60_000)
            return { repository: destination, tool: 'git' }
        }

        const repository = (await this.inspect(operation.repository)).repositoryRoot
        const requireCleanWorktree = async () => {
            const snapshot = await this.inspect(repository)
            if (snapshot.changes.length > 0) {
                throw new Error('Cannot change branches while there are uncommitted changes')
            }
            return snapshot
        }
        switch (operation.kind) {
            case 'stage':
                context.report(0.2, 'Staging changes')
                await this.run('git', operation.paths.length ? ['add', '--', ...operation.paths] : ['add', '-A'], repository, context.signal)
                break
            case 'unstage':
                context.report(0.2, 'Unstaging changes')
                if (await this.commandAvailable('git', ['rev-parse', '--verify', 'HEAD'], repository)) {
                    await this.run('git', operation.paths.length ? ['reset', 'HEAD', '--', ...operation.paths] : ['reset', 'HEAD'], repository, context.signal)
                } else {
                    await this.run(
                        'git',
                        ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...(operation.paths.length ? operation.paths : ['.'])],
                        repository,
                        context.signal
                    )
                }
                break
            case 'commit':
                context.report(0.2, 'Creating commit')
                await this.run('git', ['commit', '-m', operation.message], repository, context.signal, 5 * 60_000)
                break
            case 'set-commit-template':
                context.report(0.2, 'Saving commit template preference')
                await this.setCommitTemplate(repository, operation.template)
                break
            case 'push':
                context.report(0.1, 'Pushing commits')
                const pushRemote = operation.remote ?? 'origin'
                await this.run(
                    'git',
                    operation.setUpstream ? ['push', '-u', pushRemote, 'HEAD'] : ['push', pushRemote],
                    repository,
                    context.signal,
                    10 * 60_000
                )
                break
            case 'set-remote': {
                const url = (await this.resolveGitSource(operation.url, repository)).value
                context.report(0.2, 'Updating remote')
                const remote = operation.remote ?? 'origin'
                const exists = await this.commandAvailable('git', ['remote', 'get-url', remote], repository)
                await this.run(
                    'git',
                    exists
                        ? ['remote', 'set-url', remote, url]
                        : ['remote', 'add', remote, url],
                    repository,
                    context.signal
                )
                break
            }
            case 'fetch': {
                context.report(0.1, 'Refreshing remote branches')
                const args = operation.remote
                    ? ['fetch', '--prune', operation.remote]
                    : ['fetch', '--all', '--prune']
                await this.run('git', args, repository, context.signal, 10 * 60_000)
                break
            }
            case 'update-current': {
                await requireCleanWorktree()
                context.report(0.2, 'Fast-forwarding current branch')
                await this.run('git', ['pull', '--ff-only'], repository, context.signal, 10 * 60_000)
                break
            }
            case 'switch-branch': {
                await requireCleanWorktree()
                context.report(0.2, `Switching to ${operation.name}`)
                await this.run('git', ['switch', operation.name], repository, context.signal)
                break
            }
            case 'create-branch': {
                if (operation.switchTo ?? true) await requireCleanWorktree()
                context.report(0.2, `Creating ${operation.name}`)
                const startPoint = operation.startPoint?.trim()
                if (startPoint?.startsWith('-')) throw new Error('Invalid branch start point')
                if (operation.switchTo ?? true) {
                    await this.run('git', startPoint
                        ? ['switch', '-c', operation.name, startPoint]
                        : ['switch', '-c', operation.name], repository, context.signal)
                } else {
                    await this.run('git', startPoint
                        ? ['branch', operation.name, startPoint]
                        : ['branch', operation.name], repository, context.signal)
                }
                break
            }
            case 'delete-branch': {
                context.report(0.2, `Deleting ${operation.name}`)
                await this.run('git', ['branch', operation.force ? '-D' : '-d', operation.name], repository, context.signal)
                break
            }
            case 'delete-remote-branch': {
                context.report(0.2, `Deleting ${operation.remote ?? 'origin'}/${operation.name}`)
                await this.run('git', ['push', operation.remote ?? 'origin', '--delete', operation.name], repository, context.signal, 10 * 60_000)
                break
            }
        }
        return { repository }
    }

    private async resolveGitSource(source: string, cwd: string): Promise<{ value: string; local: boolean }> {
        assertSafeRemoteUrl(source)
        if (!isLocalGitSource(source)) return { value: source, local: false }
        const path = /^file:/i.test(source)
            ? fileURLToPath(source)
            : isAbsolute(source)
                ? source
                : resolve(cwd, source)
        return { value: await this.scope.resolveReadable(path), local: true }
    }

    private async getCommitTemplate(repository: string): Promise<GitCommitTemplate> {
        const preferences = await this.readPreferences()
        return preferences.repositories[repository] ?? 'conventional'
    }

    private async setCommitTemplate(repository: string, template: GitCommitTemplate): Promise<void> {
        const update = this.preferenceUpdate.then(async () => {
            const preferences = await this.readPreferences()
            preferences.repositories[repository] = template
            await mkdir(dirname(this.preferencePath), { recursive: true, mode: 0o700 })
            const tempPath = `${this.preferencePath}.${process.pid}.${randomUUID()}.tmp`
            await writeFile(tempPath, JSON.stringify(preferences, null, 2), { encoding: 'utf8', mode: 0o600 })
            await rename(tempPath, this.preferencePath)
        })
        this.preferenceUpdate = update.catch(() => {})
        await update
    }

    private async readPreferences(): Promise<GitPreferenceDocument> {
        try {
            const value = JSON.parse(await readFile(this.preferencePath, 'utf8')) as Partial<GitPreferenceDocument>
            if (value.version !== 1 || !value.repositories || typeof value.repositories !== 'object') return emptyPreferences()
            return {
                version: 1,
                repositories: Object.fromEntries(Object.entries(value.repositories)
                    .filter((entry): entry is [string, GitCommitTemplate] => entry[1] === 'conventional' || entry[1] === 'custom'))
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPreferences()
            throw new Error('Failed to read Git preferences')
        }
    }

    private async commandAvailable(command: string, args: string[], cwd?: string, timeout = 2_000): Promise<boolean> {
        try {
            await this.run(command, args, cwd, undefined, timeout)
            return true
        } catch {
            return false
        }
    }

    private async run(
        command: string,
        args: string[],
        cwd?: string,
        signal?: AbortSignal,
        timeout = 30_000
    ): Promise<CommandResult> {
        try {
            const result = await execFileAsync(command, args, {
                cwd,
                timeout,
                signal,
                maxBuffer: MAX_OUTPUT_BYTES,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
            })
            return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
        } catch (error) {
            const commandError = error as Error & { stderr?: string; stdout?: string }
            const detail = redact(String(commandError.stderr || commandError.stdout || commandError.message || 'Command failed')).trim()
            throw new Error(detail || `${command} failed`)
        }
    }
}
