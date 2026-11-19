import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configuration } from '@/configuration'
import { hashObject } from '@/utils/deterministicJson'
import { filterCatalogAffectingClaudeArgs } from './sdk/metadataExtractor'

export interface CatalogLaunch {
    cwd: string
    model?: string | null
    args?: readonly string[]
}

type CatalogLists = { tools?: string[], slashCommands?: string[] }

function stampPath(sessionId: string): string {
    return join(configuration.happyHomeDir, 'claude-catalog', hashObject(sessionId) + '.json')
}

export function catalogFingerprint(launch: CatalogLaunch, lists: CatalogLists): string {
    const args = launch.args ?? []
    const persistentArgs: string[] = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--') {
            persistentArgs.push(...args.slice(i))
            break
        }
        if (arg === '--resume' || arg === '-r') {
            if (i + 1 < args.length && !args[i + 1].startsWith('-')) i++
        } else if (!arg.startsWith('--resume=') && !['--continue', '-c', '--fork-session'].includes(arg)) {
            persistentArgs.push(arg)
        }
    }
    return hashObject([launch.cwd, launch.model ?? null, persistentArgs, lists.tools, lists.slashCommands])
}

export function recordCatalog(sessionId: string, launch: CatalogLaunch, lists: CatalogLists, version?: string): void {
    const file = stampPath(sessionId)
    const tmp = file + '.' + randomUUID()
    try {
        if (!version || !lists.tools?.length || !lists.slashCommands?.length) {
            rmSync(file, { force: true })
            return
        }
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
        const stamp = { fingerprint: catalogFingerprint(launch, lists), version, time: Date.now() }
        writeFileSync(tmp, JSON.stringify(stamp), { mode: 0o600 })
        renameSync(tmp, file)
    } catch {
        // Cache I/O is best effort.
    } finally {
        try { rmSync(tmp, { force: true }) } catch {}
    }
}

export function canReuseCatalog(
    sessionId: string,
    launch: CatalogLaunch,
    metadata: (CatalogLists & { path: string }) | null | undefined,
    versionOutput: string | null
): boolean {
    if (metadata?.path !== launch.cwd || !metadata.tools?.length || !metadata.slashCommands?.length
        || filterCatalogAffectingClaudeArgs(launch.args).length) return false
    try {
        const stamp = JSON.parse(readFileSync(stampPath(sessionId), 'utf8'))
        const age = Date.now() - stamp.time
        if (typeof stamp.time !== 'number' || age < 0 || age >= 24 * 60 * 60 * 1000
            || stamp.fingerprint !== catalogFingerprint(launch, metadata)) return false
        const version = versionOutput?.match(/^(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)(?:\s|$)/)?.[1]
        return Boolean(version && version === stamp.version)
    } catch {
        return false
    }
}
