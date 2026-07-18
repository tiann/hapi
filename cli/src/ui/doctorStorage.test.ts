import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectStorageSnapshot, formatStorageReport, type StorageSnapshot } from './doctorStorage'

const tempDirs: string[] = []

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-storage-test-'))
    tempDirs.push(dir)
    return dir
}

function makeSqliteStub(dir: string, body: string): string {
    const path = join(dir, 'sqlite3-stub')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
}

describe('doctor storage report', () => {
    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('reports a missing database without creating it', async () => {
        const homeDir = makeTempDir()

        const snapshot = await collectStorageSnapshot({ homeDir })

        expect(snapshot.db.exists).toBe(false)
        expect(snapshot.db.status).toBe('missing')
        expect(snapshot.db.sizeBytes).toBe(0)
        expect(snapshot.files.some((entry) => entry.path.endsWith('hapi.db'))).toBe(false)
    })

    it('does not create a missing home directory while collecting a dry-run snapshot', async () => {
        const parent = makeTempDir()
        const homeDir = join(parent, 'missing-hapi-home')

        const snapshot = await collectStorageSnapshot({ homeDir })

        expect(snapshot.db.exists).toBe(false)
        expect(snapshot.db.status).toBe('missing')
        expect(snapshot.files).toEqual([])
        expect(existsSync(homeDir)).toBe(false)
    })

    it('formats DB reclaim opportunity as a dry-run recommendation', () => {
        const snapshot: StorageSnapshot = {
            generatedAt: '2026-05-29T12:00:00.000Z',
            homeDir: '/tmp/.hapi',
            files: [{ path: '/tmp/.hapi/hapi.db', relativePath: 'hapi.db', type: 'file', sizeBytes: 200 * 1024 * 1024 }],
            db: {
                path: '/tmp/.hapi/hapi.db',
                exists: true,
                status: 'ok',
                sizeBytes: 200 * 1024 * 1024,
                pageCount: 50_000,
                pageSize: 4096,
                freelistCount: 20_000,
                reclaimableBytes: 81_920_000,
                totalMessages: 75_000,
                largestMessageBytes: 3_500_000,
                totalSessions: 300,
                activeSessions: 12,
                topMessageSessions: [{ sessionId: 's1', messages: 5000 }]
            },
            warnings: []
        }

        const report = formatStorageReport(snapshot)

        expect(report).toContain('Dry-run only: no files were changed')
        expect(report).toContain('Reclaimable:')
        expect(report).toContain('VACUUM may reclaim')
        expect(report).toContain('Messages: 75000')
        expect(report).toContain('s1: 5000 messages')
    })

    it('includes top-level storage files in the snapshot', async () => {
        const homeDir = makeTempDir()
        writeFileSync(join(homeDir, 'hapi.log'), 'log-data')

        const snapshot = await collectStorageSnapshot({ homeDir })

        expect(snapshot.files).toEqual(expect.arrayContaining([
            expect.objectContaining({ relativePath: 'hapi.log', sizeBytes: 8 })
        ]))
    })

    it('collects all SQLite metrics with one read-only snapshot query', async () => {
        const homeDir = makeTempDir()
        const dbPath = join(homeDir, 'hapi.db')
        const counter = join(homeDir, 'calls')
        writeFileSync(dbPath, 'fixture')
        const sqliteExecutable = makeSqliteStub(homeDir, [
            `echo call >> '${counter}'`,
            `printf '%s\\n' '[{"pageCount":10,"pageSize":4096,"freelistCount":2,"totalMessages":4,"largestMessageBytes":99,"totalSessions":3,"activeSessions":0,"topMessageSessionsJson":"[{\\"sessionId\\":\\"s1\\",\\"messages\\":4}]"}]'`,
        ].join('\n'))

        const snapshot = await collectStorageSnapshot({ homeDir, sqliteExecutable })

        expect(snapshot.db).toMatchObject({
            status: 'ok',
            pageCount: 10,
            pageSize: 4096,
            reclaimableBytes: 8192,
            totalMessages: 4,
            totalSessions: 3,
            activeSessions: 0,
            topMessageSessions: [{ sessionId: 's1', messages: 4 }]
        })
        expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
        expect(snapshot.warnings).toEqual([])
    })

    it('reports SQLite query errors as unknown metrics instead of zero/null success', async () => {
        const homeDir = makeTempDir()
        writeFileSync(join(homeDir, 'hapi.db'), 'corrupt')
        const sqliteExecutable = makeSqliteStub(homeDir, 'exit 7')

        const snapshot = await collectStorageSnapshot({ homeDir, sqliteExecutable })

        expect(snapshot.db.status).toBe('error')
        expect(snapshot.db.totalMessages).toBeNull()
        expect(snapshot.warnings).toEqual([
            'SQLite snapshot query failed; storage metrics are unknown (not zero).'
        ])
    })

    it('reports SQLite timeouts separately from query errors', async () => {
        const homeDir = makeTempDir()
        writeFileSync(join(homeDir, 'hapi.db'), 'slow')
        const sqliteExecutable = makeSqliteStub(homeDir, 'sleep 1')

        const snapshot = await collectStorageSnapshot({
            homeDir,
            sqliteExecutable,
            sqliteTimeoutMs: 25,
        })

        expect(snapshot.db.status).toBe('timeout')
        expect(snapshot.warnings).toEqual([
            'SQLite snapshot query timed out; storage metrics are unknown (not zero).'
        ])
    })
})
