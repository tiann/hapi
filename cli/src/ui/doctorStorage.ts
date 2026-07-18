import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'

export type DoctorStorageOptions = {
    json?: boolean
    limit?: number
    homeDir?: string
    sqliteExecutable?: string
    sqliteTimeoutMs?: number
}

export type StorageDatabaseStatus = 'missing' | 'ok' | 'timeout' | 'error'

export type StorageFileEntry = {
    path: string
    relativePath: string
    type: 'file' | 'directory'
    sizeBytes: number
}

export type StorageTopMessageSession = {
    sessionId: string
    messages: number
}

export type StorageSnapshot = {
    generatedAt: string
    homeDir: string
    files: StorageFileEntry[]
    db: {
        path: string
        exists: boolean
        status: StorageDatabaseStatus
        sizeBytes: number
        pageCount: number | null
        pageSize: number | null
        freelistCount: number | null
        reclaimableBytes: number | null
        totalMessages: number | null
        largestMessageBytes: number | null
        totalSessions: number | null
        activeSessions: number | null
        topMessageSessions: StorageTopMessageSession[]
    }
    warnings: string[]
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
    if (!value.trim()) {
        return []
    }
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

type DatabaseMetrics = {
    pageCount: number
    pageSize: number
    freelistCount: number
    totalMessages: number
    largestMessageBytes: number
    totalSessions: number
    activeSessions: number
    topMessageSessions: StorageTopMessageSession[]
}

type DatabaseSnapshotResult =
    | { status: 'missing' }
    | { status: 'ok'; metrics: DatabaseMetrics }
    | { status: 'timeout' | 'error' }

function requiredNumber(row: Record<string, unknown>, key: string): number {
    const value = asNumber(row[key])
    if (value === null) throw new Error(`SQLite snapshot field ${key} is not numeric`)
    return value
}

function parseTopMessageSessions(value: unknown): StorageTopMessageSession[] {
    if (typeof value !== 'string') throw new Error('SQLite snapshot top sessions are missing')
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('SQLite snapshot top sessions are malformed')
    return parsed.map((item) => {
        if (typeof item !== 'object' || item === null) throw new Error('SQLite snapshot top session is malformed')
        const row = item as Record<string, unknown>
        if (typeof row.sessionId !== 'string' || !row.sessionId) throw new Error('SQLite snapshot session ID is malformed')
        return { sessionId: row.sessionId, messages: requiredNumber(row, 'messages') }
    })
}

function isTimeoutError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false
    const details = error as { code?: unknown; killed?: unknown; signal?: unknown }
    return details.code === 'ETIMEDOUT'
        || (details.killed === true && (details.signal === 'SIGTERM' || details.signal === 'SIGKILL'))
}

function readDatabaseSnapshot(
    dbPath: string,
    limit: number,
    sqliteExecutable: string,
    timeout: number,
): DatabaseSnapshotResult {
    if (!existsSync(dbPath)) return { status: 'missing' }

    const sql = `
        PRAGMA query_only = ON;
        BEGIN;
        SELECT
            (SELECT page_count FROM pragma_page_count) AS pageCount,
            (SELECT page_size FROM pragma_page_size) AS pageSize,
            (SELECT freelist_count FROM pragma_freelist_count) AS freelistCount,
            (SELECT COUNT(*) FROM messages) AS totalMessages,
            (SELECT COALESCE(MAX(LENGTH(content)), 0) FROM messages) AS largestMessageBytes,
            (SELECT COUNT(*) FROM sessions) AS totalSessions,
            (SELECT COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) FROM sessions) AS activeSessions,
            COALESCE((
                SELECT json_group_array(json_object('sessionId', sessionId, 'messages', messages))
                FROM (
                    SELECT session_id AS sessionId, COUNT(*) AS messages
                    FROM messages
                    GROUP BY session_id
                    ORDER BY messages DESC
                    LIMIT ${limit}
                )
            ), '[]') AS topMessageSessionsJson;
        COMMIT;
    `

    try {
        const output = execFileSync(sqliteExecutable, ['-readonly', '-json', dbPath, sql], {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const row = parseJsonArray(output)[0]
        if (!row) throw new Error('SQLite snapshot returned no row')
        return {
            status: 'ok',
            metrics: {
                pageCount: requiredNumber(row, 'pageCount'),
                pageSize: requiredNumber(row, 'pageSize'),
                freelistCount: requiredNumber(row, 'freelistCount'),
                totalMessages: requiredNumber(row, 'totalMessages'),
                largestMessageBytes: requiredNumber(row, 'largestMessageBytes'),
                totalSessions: requiredNumber(row, 'totalSessions'),
                activeSessions: requiredNumber(row, 'activeSessions'),
                topMessageSessions: parseTopMessageSessions(row.topMessageSessionsJson),
            },
        }
    } catch (error) {
        return { status: isTimeoutError(error) ? 'timeout' : 'error' }
    }
}

function safeStatSize(path: string): number {
    try {
        return statSync(path).size
    } catch {
        return 0
    }
}

function directorySize(path: string): number {
    let total = 0
    try {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const childPath = join(path, entry.name)
            if (entry.isDirectory()) {
                total += directorySize(childPath)
            } else if (entry.isFile()) {
                total += safeStatSize(childPath)
            }
        }
    } catch {
        return total
    }
    return total
}

function listStorageFiles(homeDir: string): StorageFileEntry[] {
    if (!existsSync(homeDir)) {
        return []
    }

    try {
        return readdirSync(homeDir, { withFileTypes: true })
            .map((entry) => {
                const path = join(homeDir, entry.name)
                const type = entry.isDirectory() ? 'directory' as const : 'file' as const
                return {
                    path,
                    relativePath: entry.name,
                    type,
                    sizeBytes: type === 'directory' ? directorySize(path) : safeStatSize(path)
                }
            })
            .sort((a, b) => b.sizeBytes - a.sizeBytes)
    } catch {
        return []
    }
}

function formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) {
        return 'n/a'
    }
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024
        unitIndex += 1
    }
    const digits = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
    return `${value.toFixed(digits)} ${units[unitIndex]}`
}

export function resolveHapiHomeDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.HAPI_HOME) {
        return env.HAPI_HOME.replace(/^~/, homedir())
    }
    return join(homedir(), '.hapi')
}

export async function collectStorageSnapshot(options: DoctorStorageOptions = {}): Promise<StorageSnapshot> {
    const homeDir = options.homeDir ?? resolveHapiHomeDir()
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50))
    const dbPath = join(homeDir, 'hapi.db')
    const dbExists = existsSync(dbPath)
    const database = readDatabaseSnapshot(
        dbPath,
        limit,
        options.sqliteExecutable ?? 'sqlite3',
        Math.max(1, options.sqliteTimeoutMs ?? 2_000),
    )
    const metrics = database.status === 'ok' ? database.metrics : null
    const reclaimableBytes = metrics ? metrics.freelistCount * metrics.pageSize : null

    const warnings: string[] = []
    if (database.status === 'timeout') {
        warnings.push('SQLite snapshot query timed out; storage metrics are unknown (not zero).')
    } else if (database.status === 'error') {
        warnings.push('SQLite snapshot query failed; storage metrics are unknown (not zero).')
    }

    return {
        generatedAt: new Date().toISOString(),
        homeDir,
        files: listStorageFiles(homeDir),
        db: {
            path: dbPath,
            exists: dbExists,
            status: database.status,
            sizeBytes: dbExists ? safeStatSize(dbPath) : 0,
            pageCount: metrics?.pageCount ?? null,
            pageSize: metrics?.pageSize ?? null,
            freelistCount: metrics?.freelistCount ?? null,
            reclaimableBytes,
            totalMessages: metrics?.totalMessages ?? null,
            largestMessageBytes: metrics?.largestMessageBytes ?? null,
            totalSessions: metrics?.totalSessions ?? null,
            activeSessions: metrics?.activeSessions ?? null,
            topMessageSessions: metrics?.topMessageSessions ?? [],
        },
        warnings
    }
}

export function formatStorageReport(snapshot: StorageSnapshot): string {
    const lines = [
        'hapi doctor storage',
        'Dry-run only: no files were changed.',
        `Generated: ${snapshot.generatedAt}`,
        `Home: ${snapshot.homeDir}`,
        ''
    ]

    if (!snapshot.db.exists) {
        lines.push(`Database: missing (${snapshot.db.path})`)
    } else {
        lines.push(`Database: ${snapshot.db.path}`)
        lines.push(`Size: ${formatBytes(snapshot.db.sizeBytes)}`)
        lines.push(`Snapshot status: ${snapshot.db.status}`)
        if (snapshot.db.status === 'ok') {
            lines.push(`Pages: count=${snapshot.db.pageCount} size=${snapshot.db.pageSize} freelist=${snapshot.db.freelistCount}`)
            lines.push(`Reclaimable: ${formatBytes(snapshot.db.reclaimableBytes)}`)
            lines.push(`Messages: ${snapshot.db.totalMessages} largest=${formatBytes(snapshot.db.largestMessageBytes)}`)
            lines.push(`Sessions: total=${snapshot.db.totalSessions} active=${snapshot.db.activeSessions}`)
            if ((snapshot.db.reclaimableBytes ?? 0) >= 64 * 1024 * 1024) {
                lines.push(`Recommendation: VACUUM may reclaim ${formatBytes(snapshot.db.reclaimableBytes)}; not run automatically.`)
            }
        } else {
            lines.push('Metrics: unknown (snapshot did not complete)')
        }
    }

    if (snapshot.db.topMessageSessions.length > 0) {
        lines.push('')
        lines.push('Top sessions by message count:')
        for (const row of snapshot.db.topMessageSessions) {
            lines.push(`- ${row.sessionId}: ${row.messages} messages`)
        }
    }

    if (snapshot.files.length > 0) {
        lines.push('')
        lines.push('Top-level storage entries:')
        for (const entry of snapshot.files.slice(0, 20)) {
            lines.push(`- ${entry.relativePath} (${entry.type}): ${formatBytes(entry.sizeBytes)}`)
        }
    }

    if (snapshot.warnings.length > 0) {
        lines.push('')
        lines.push(`Warnings: ${snapshot.warnings.join('; ')}`)
    }

    return lines.join('\n')
}

export async function runDoctorStorage(options: DoctorStorageOptions = {}): Promise<void> {
    const snapshot = await collectStorageSnapshot(options)
    if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2))
        return
    }
    console.log(chalk.cyan(formatStorageReport(snapshot)))
}
