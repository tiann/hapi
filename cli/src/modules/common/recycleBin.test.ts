import { beforeEach, describe, expect, it, vi } from 'vitest'

const recycleBinIoHarness = vi.hoisted(() => ({
    shortWrite: false,
    rejectSync: false,
    rejectDirectorySync: false,
    directorySyncCalls: 0,
    directorySyncFailureAt: undefined as number | undefined,
    replaceSourceBeforeDetach: undefined as { path: string; replacementPath: string } | undefined,
    rejectDetachedUnlink: false,
}))

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    return {
        ...actual,
        rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
            const replacement = recycleBinIoHarness.replaceSourceBeforeDetach
            if (replacement && sourcePath === replacement.path && destinationPath.includes('.hapi-source-')) {
                recycleBinIoHarness.replaceSourceBeforeDetach = undefined
                await actual.writeFile(replacement.replacementPath, 'concurrent replacement')
                await actual.rm(replacement.path, { force: true })
                await actual.rename(replacement.replacementPath, replacement.path)
            }
            return await actual.rename(sourcePath, destinationPath)
        }),
        unlink: vi.fn(async (path: string) => {
            if (recycleBinIoHarness.rejectDetachedUnlink && path.includes('.hapi-source-')) {
                const error = new Error('Simulated detached-source unlink failure') as NodeJS.ErrnoException
                error.code = 'EIO'
                throw error
            }
            return await actual.unlink(path)
        }),
        open: vi.fn(async (...args: [string, string | number, number?]) => {
            const handle = await actual.open(...args)
            const isDestinationHandle = args[1] === 'wx'
            const isDirectoryHandle = typeof args[1] === 'number'
            if ((!isDestinationHandle || (!recycleBinIoHarness.shortWrite && !recycleBinIoHarness.rejectSync))
                && (!isDirectoryHandle || !recycleBinIoHarness.rejectDirectorySync)) {
                return handle
            }

            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'write' && recycleBinIoHarness.shortWrite) {
                        return async (buffer: Buffer, bufferOffset: number, length: number, position: number) => {
                            const shortLength = Math.max(1, Math.floor(length / 2))
                            return await target.write(buffer, bufferOffset, shortLength, position)
                        }
                    }
                    if (property === 'sync' && (recycleBinIoHarness.rejectSync || recycleBinIoHarness.rejectDirectorySync)) {
                        return async () => {
                            if (isDirectoryHandle) {
                                recycleBinIoHarness.directorySyncCalls += 1
                                if (recycleBinIoHarness.directorySyncFailureAt !== undefined
                                    && recycleBinIoHarness.directorySyncCalls >= recycleBinIoHarness.directorySyncFailureAt) {
                                    const error = new Error('Simulated recycle-bin directory sync failure') as NodeJS.ErrnoException
                                    error.code = 'EIO'
                                    throw error
                                }
                                return
                            }
                            throw new Error('Simulated recycle-bin sync failure')
                        }
                    }
                    const value = Reflect.get(target, property, target)
                    return typeof value === 'function' ? value.bind(target) : value
                },
            })
        }),
    }
})

import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
    DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    getRecycleBinRoot,
    MAX_RECYCLE_BIN_PREVIEW_BYTES,
    RecycleBinManager,
    resolveRecycleBinRetentionDays,
} from './recycleBin'

const DAY_MS = 24 * 60 * 60 * 1000

async function createTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `${prefix}-`))
}

function createManager(
    homeDir: string,
    now: () => number = () => 0,
    retentionDays = DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    ownerNamespace = 'default',
): RecycleBinManager {
    return new RecycleBinManager(homeDir, now, async () => retentionDays, ownerNamespace)
}

describe('RecycleBinManager', () => {
    let homeDir: string
    let workspaceDir: string

    beforeEach(async () => {
        recycleBinIoHarness.shortWrite = false
        recycleBinIoHarness.rejectSync = false
        recycleBinIoHarness.rejectDirectorySync = false
        recycleBinIoHarness.directorySyncCalls = 0
        recycleBinIoHarness.directorySyncFailureAt = undefined
        recycleBinIoHarness.replaceSourceBeforeDetach = undefined
        recycleBinIoHarness.rejectDetachedUnlink = false
        homeDir = await createTempDir('hapi-recycle-home')
        workspaceDir = await createTempDir('hapi-recycle-workspace')
    })

    async function cleanup(): Promise<void> {
        await rm(homeDir, { recursive: true, force: true })
        await rm(workspaceDir, { recursive: true, force: true })
    }

    it('accepts bounded positive retention values and falls back for invalid settings', () => {
        expect(resolveRecycleBinRetentionDays(7)).toBe(7)
        expect(resolveRecycleBinRetentionDays(1)).toBe(1)
        expect(resolveRecycleBinRetentionDays(undefined)).toBe(DEFAULT_RECYCLE_BIN_RETENTION_DAYS)
        expect(resolveRecycleBinRetentionDays(0)).toBe(DEFAULT_RECYCLE_BIN_RETENTION_DAYS)
        expect(resolveRecycleBinRetentionDays(3651)).toBe(DEFAULT_RECYCLE_BIN_RETENTION_DAYS)
        expect(resolveRecycleBinRetentionDays('7')).toBe(DEFAULT_RECYCLE_BIN_RETENTION_DAYS)
    })

    it('moves a file into local storage and lists/reads its metadata without exposing contents in the list', async () => {
        try {
            const filePath = join(workspaceDir, 'notes.md')
            await writeFile(filePath, '# notes')
            const manager = createManager(homeDir, () => 1_000, 7)

            const moved = await manager.moveFile('notes.md', workspaceDir)
            expect(moved.success).toBe(true)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            expect(moved.retentionDays).toBe(7)
            expect(moved.entry).toMatchObject({
                name: 'notes.md',
                type: 'file',
                size: 7,
                deletedAt: 1_000,
                expiresAt: 1_000 + 7 * DAY_MS,
            })
            await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })

            const listed = await manager.list(workspaceDir)
            expect(listed).toMatchObject({ success: true, retentionDays: 7 })
            expect(listed.entries).toEqual([moved.entry])
            expect(JSON.stringify(listed)).not.toContain('# notes')

            const preview = await manager.read(moved.entry.id, workspaceDir)
            expect(preview).toMatchObject({
                success: true,
                name: 'notes.md',
                size: 7,
                modified: 1_000,
                content: Buffer.from('# notes').toString('base64'),
            })
        } finally {
            await cleanup()
        }
    })

    it('restores a file to its original path and removes the recycle entry', async () => {
        try {
            const filePath = join(workspaceDir, 'restore.txt')
            await writeFile(filePath, 'restore me')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toEqual({ success: true, restoredPath: filePath })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('restore me')
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [] })
            await expect(stat(join(getRecycleBinRoot(homeDir), moved.entry.id))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await cleanup()
        }
    })

    it('returns a stable not-found code when restoring a purged entry', async () => {
        try {
            const filePath = join(workspaceDir, 'purged.txt')
            await writeFile(filePath, 'purged')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            expect(await manager.purge(moved.entry.id, workspaceDir)).toEqual({ success: true })

            await expect(manager.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toMatchObject({
                success: false,
                code: 'entry_not_found',
                error: 'Recycle-bin entry not found',
            })
        } finally {
            await cleanup()
        }
    })

    it('returns a stable not-found code when restoring an expired entry', async () => {
        try {
            let now = 0
            const filePath = join(workspaceDir, 'expired-restore.txt')
            await writeFile(filePath, 'expired')
            const manager = createManager(homeDir, () => now, 1)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            now = DAY_MS

            await expect(manager.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toMatchObject({
                success: false,
                code: 'entry_not_found',
                error: 'Recycle-bin entry not found',
            })
        } finally {
            await cleanup()
        }
    })

    it('copies files with additional hard links before moving them to the recycle bin', async () => {
        try {
            const filePath = join(workspaceDir, 'hard-link.txt')
            const linkedPath = join(workspaceDir, 'hard-link-alias.txt')
            await writeFile(filePath, 'preserve this snapshot')
            await link(filePath, linkedPath)
            const manager = createManager(homeDir)

            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            await writeFile(linkedPath, 'mutated through the remaining hard link')

            await expect(manager.read(moved.entry.id, workspaceDir)).resolves.toMatchObject({
                success: true,
                content: Buffer.from('preserve this snapshot').toString('base64'),
            })
            await expect(manager.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toEqual({
                success: true,
                restoredPath: filePath,
            })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('preserve this snapshot')
            await expect(readFile(linkedPath, 'utf8')).resolves.toBe('mutated through the remaining hard link')
        } finally {
            await cleanup()
        }
    })

    it('keeps the deletion-time snapshot when a source handle remains open', async () => {
        try {
            const filePath = join(workspaceDir, 'open-handle.txt')
            await writeFile(filePath, 'preserve this snapshot')
            const sourceHandle = await open(filePath, 'r+')
            try {
                const manager = createManager(homeDir)
                const moved = await manager.moveFile(filePath, workspaceDir)
                if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

                const mutation = Buffer.from('mutated through the open handle')
                await sourceHandle.write(mutation, 0, mutation.length, 0)
                await sourceHandle.sync()

                await expect(manager.read(moved.entry.id, workspaceDir)).resolves.toMatchObject({
                    success: true,
                    content: Buffer.from('preserve this snapshot').toString('base64'),
                })
                await expect(manager.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toEqual({
                    success: true,
                    restoredPath: filePath,
                })
                await expect(readFile(filePath, 'utf8')).resolves.toBe('preserve this snapshot')
            } finally {
                await sourceHandle.close()
            }
        } finally {
            await cleanup()
        }
    })

    it('does not unlink a replacement installed before the copy-path removal', async () => {
        try {
            const filePath = join(workspaceDir, 'replacement.txt')
            const linkedPath = join(workspaceDir, 'replacement-alias.txt')
            const replacementPath = join(workspaceDir, 'replacement-staging.txt')
            await writeFile(filePath, 'original contents')
            await link(filePath, linkedPath)
            const manager = createManager(homeDir)
            recycleBinIoHarness.replaceSourceBeforeDetach = { path: filePath, replacementPath }

            const moved = await manager.moveFile(filePath, workspaceDir)
            expect(moved).toMatchObject({ success: false, error: 'File changed before the recycle-bin operation completed' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('concurrent replacement')
            await expect(readFile(linkedPath, 'utf8')).resolves.toBe('original contents')
            await expect(readdir(workspaceDir)).resolves.not.toContain(expect.stringMatching(/^\.hapi-source-/))
        } finally {
            await cleanup()
        }
    })

    it('isolates recycle entries when the same HAPI home is reused by another namespace', async () => {
        try {
            const filePath = join(workspaceDir, 'namespace.txt')
            await writeFile(filePath, 'namespace-owned')
            const alice = createManager(homeDir, () => 0, DEFAULT_RECYCLE_BIN_RETENTION_DAYS, 'alice')
            const bob = createManager(homeDir, () => 0, DEFAULT_RECYCLE_BIN_RETENTION_DAYS, 'bob')
            const moved = await alice.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            await expect(bob.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [] })
            await expect(bob.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toMatchObject({
                success: false,
                code: 'entry_not_found',
            })
            await expect(bob.empty(workspaceDir, [moved.entry.id])).resolves.toEqual({
                success: true,
                deletedCount: 0,
            })
            await expect(alice.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [moved.entry] })
        } finally {
            await cleanup()
        }
    })

    it('cleans expired entries from retired namespaces without exposing live entries', async () => {
        try {
            let aliceNow = 0
            const filePath = join(workspaceDir, 'retired-namespace.txt')
            await writeFile(filePath, 'retired namespace')
            const alice = createManager(homeDir, () => aliceNow, 1, 'alice')
            const bob = createManager(homeDir, () => DAY_MS, 1, 'bob')
            const moved = await alice.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            aliceNow = DAY_MS

            await expect(bob.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [] })
            await expect(stat(join(getRecycleBinRoot(homeDir), moved.entry.id))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await cleanup()
        }
    })

    it('cleans a large expired bin without opening all entries at once', async () => {
        try {
            const root = getRecycleBinRoot(homeDir)
            const payload = Buffer.from('expired payload')
            const contentHash = createHash('sha256').update(payload).digest('hex')
            const entryCount = 512
            await mkdir(root, { recursive: true })
            for (let index = 0; index < entryCount; index += 1) {
                const id = randomUUID()
                const directory = join(root, id)
                await mkdir(directory)
                await writeFile(join(directory, 'payload'), payload)
                await writeFile(join(directory, 'metadata.json'), JSON.stringify({
                    version: 2,
                    id,
                    name: `expired-${index}.txt`,
                    originalPath: join(workspaceDir, `expired-${index}.txt`),
                    ownerNamespace: index % 2 === 0 ? 'alice' : 'retired',
                    scopeRoot: workspaceDir,
                    type: 'file',
                    size: payload.length,
                    mode: 0o100644,
                    contentHash,
                    deletedAt: 0,
                    expiresAt: 0,
                }))
            }

            await expect(createManager(homeDir).list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [],
            })
            await expect(readdir(root)).resolves.toEqual([])
        } finally {
            await cleanup()
        }
    })

    it('cleans expired entries even when their payload is missing or truncated', async () => {
        try {
            const root = getRecycleBinRoot(homeDir)
            await mkdir(root, { recursive: true })
            const contentHash = createHash('sha256').update('expected payload').digest('hex')
            const entries = [
                { id: randomUUID(), payload: null as string | null },
                { id: randomUUID(), payload: 'short' },
            ]
            for (const [index, item] of entries.entries()) {
                const directory = join(root, item.id)
                await mkdir(directory)
                await writeFile(join(directory, 'metadata.json'), JSON.stringify({
                    version: 2,
                    id: item.id,
                    name: `incomplete-${index}.txt`,
                    originalPath: join(workspaceDir, `incomplete-${index}.txt`),
                    ownerNamespace: 'default',
                    scopeRoot: workspaceDir,
                    type: 'file',
                    size: 'expected payload'.length,
                    mode: 0o100644,
                    contentHash,
                    deletedAt: 0,
                    expiresAt: 0,
                }))
                if (item.payload !== null) await writeFile(join(directory, 'payload'), item.payload)
            }

            await expect(createManager(homeDir, () => DAY_MS).list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [],
            })
            for (const item of entries) {
                await expect(stat(join(root, item.id))).rejects.toMatchObject({ code: 'ENOENT' })
            }
        } finally {
            await cleanup()
        }
    })

    it('reconciles owned staging files on the next recycle-bin access', async () => {
        try {
            const filePath = join(workspaceDir, 'staging-reconciliation.txt')
            await writeFile(filePath, 'reconcile staging files')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const stagingNames = [
                `.hapi-source-${moved.entry.id}.tmp`,
                `.hapi-restore-${moved.entry.id}.tmp`,
            ]
            for (const name of stagingNames) {
                await writeFile(join(workspaceDir, name), 'reconcile staging files')
            }
            const rollbackStage = join(getRecycleBinRoot(homeDir), moved.entry.id, `.hapi-source-${moved.entry.id}.tmp`)
            await writeFile(rollbackStage, 'reconcile staging files')

            await expect(manager.list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [moved.entry],
            })
            for (const name of stagingNames) {
                await expect(stat(join(workspaceDir, name))).rejects.toMatchObject({ code: 'ENOENT' })
            }
            await expect(stat(rollbackStage)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await cleanup()
        }
    })

    it('does not remove unrelated files that reuse staging names', async () => {
        try {
            const filePath = join(workspaceDir, 'staging-name-collision.txt')
            await writeFile(filePath, 'original contents')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const sourceStage = join(workspaceDir, `.hapi-source-${moved.entry.id}.tmp`)
            const restoreStage = join(workspaceDir, `.hapi-restore-${moved.entry.id}.tmp`)
            await writeFile(sourceStage, 'unrelated source-stage file')
            await writeFile(restoreStage, 'unrelated restore-stage file')

            await expect(manager.list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [moved.entry],
            })
            await expect(readFile(sourceStage, 'utf8')).resolves.toBe('unrelated source-stage file')
            await expect(readFile(restoreStage, 'utf8')).resolves.toBe('unrelated restore-stage file')
        } finally {
            await cleanup()
        }
    })

    it('does not remove a pre-existing restore staging file when staging fails', async () => {
        try {
            const filePath = join(workspaceDir, 'restore-stage-collision.txt')
            await writeFile(filePath, 'original contents')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const stagingPath = join(workspaceDir, `.hapi-restore-${moved.entry.id}.tmp`)
            await writeFile(stagingPath, 'pre-existing user file')
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')

            expect(restored).toMatchObject({ success: false })
            await expect(readFile(stagingPath, 'utf8')).resolves.toBe('pre-existing user file')
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [moved.entry],
            })
        } finally {
            await cleanup()
        }
    })

    it('keeps the recycle entry when detached-source cleanup is temporarily unavailable', async () => {
        try {
            const filePath = join(workspaceDir, 'detached-cleanup-failure.txt')
            await writeFile(filePath, 'retain the recoverable payload')
            const manager = createManager(homeDir)
            recycleBinIoHarness.rejectDetachedUnlink = true

            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            const stagingPath = join(workspaceDir, `.hapi-source-${moved.entry.id}.tmp`)
            expect(moved.success).toBe(true)
            await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(stat(stagingPath)).resolves.toBeDefined()

            recycleBinIoHarness.rejectDetachedUnlink = false
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [moved.entry],
            })
            await expect(stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(manager.restore(moved.entry.id, workspaceDir, 'fail')).resolves.toEqual({
                success: true,
                restoredPath: filePath,
            })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('retain the recoverable payload')
        } finally {
            recycleBinIoHarness.rejectDetachedUnlink = false
            await cleanup()
        }
    })

    it('keeps the source when the new recycle entry cannot be committed to disk', async () => {
        try {
            const filePath = join(workspaceDir, 'metadata-durability.txt')
            await writeFile(filePath, 'keep the source')
            const manager = createManager(homeDir)
            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 3

            const moved = await manager.moveFile(filePath, workspaceDir)
            expect(moved).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('keep the source')
        } finally {
            await cleanup()
        }
    })

    it('keeps the source when the recycle-bin root cannot be committed to the HAPI home', async () => {
        try {
            const filePath = join(workspaceDir, 'root-durability.txt')
            await writeFile(filePath, 'keep the source')
            const manager = createManager(homeDir)
            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 1

            const moved = await manager.moveFile(filePath, workspaceDir)
            expect(moved).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('keep the source')
        } finally {
            await cleanup()
        }
    })

    it('supports cancel, overwrite, and restore-with-new-name conflict choices', async () => {
        try {
            const filePath = join(workspaceDir, 'conflict.txt')
            await writeFile(filePath, 'original')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            await writeFile(filePath, 'current')

            const failed = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(failed).toMatchObject({ success: false, code: 'target_exists', targetPath: filePath })
            expect(await readFile(filePath, 'utf8')).toBe('current')

            const cancelled = await manager.restore(moved.entry.id, workspaceDir, 'cancel')
            expect(cancelled).toMatchObject({ success: true, cancelled: true, targetPath: filePath })
            expect((await manager.list(workspaceDir)).entries).toHaveLength(1)

            const newName = await manager.restore(moved.entry.id, workspaceDir, 'new-name')
            expect(newName.success).toBe(true)
            if (!newName.success || !newName.restoredPath) throw new Error('new-name restore did not return a path')
            expect(basename(newName.restoredPath)).toBe('conflict (restored).txt')
            await expect(readFile(filePath, 'utf8')).resolves.toBe('current')
            await expect(readFile(newName.restoredPath, 'utf8')).resolves.toBe('original')
            expect((await manager.list(workspaceDir)).entries).toHaveLength(0)
        } finally {
            await cleanup()
        }
    })

    it('overwrites an existing regular file only when explicitly requested', async () => {
        try {
            const filePath = join(workspaceDir, 'overwrite.txt')
            await writeFile(filePath, 'old')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            await writeFile(filePath, 'new')
            const legacyBackupPath = join(workspaceDir, `.${basename(filePath)}.${moved.entry.id}.hapi-restore-backup`)
            await writeFile(legacyBackupPath, 'unrelated backup')

            const restored = await manager.restore(moved.entry.id, workspaceDir, 'overwrite')
            expect(restored).toEqual({ success: true, restoredPath: filePath })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('old')
            await expect(readFile(legacyBackupPath, 'utf8')).resolves.toBe('unrelated backup')
            await expect(readdir(workspaceDir)).resolves.not.toContain(expect.stringMatching(/^\.hapi-restore-/))
            expect((await manager.list(workspaceDir)).entries).toHaveLength(0)
        } finally {
            await cleanup()
        }
    })

    it('restores the recorded permission bits after a copy-based restore', async () => {
        try {
            const filePath = join(workspaceDir, 'permissions.txt')
            await writeFile(filePath, 'permissions')
            await chmod(filePath, 0o764)
            const originalMode = (await stat(filePath)).mode & 0o7777
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toEqual({ success: true, restoredPath: filePath })
            expect((await stat(filePath)).mode & 0o7777).toBe(originalMode)
        } finally {
            await cleanup()
        }
    })

    it('retries short destination writes until the full restore payload is copied', async () => {
        try {
            const filePath = join(workspaceDir, 'short-write.txt')
            const content = 'short writes must not truncate the restored payload\n'.repeat(128)
            await writeFile(filePath, content)
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.shortWrite = true
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toEqual({ success: true, restoredPath: filePath })
            await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
        } finally {
            await cleanup()
        }
    })

    it('retains the recycle payload when destination sync fails', async () => {
        try {
            const filePath = join(workspaceDir, 'sync-failure.txt')
            await writeFile(filePath, 'keep the payload')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.rejectSync = true
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toMatchObject({ success: false, error: 'Simulated recycle-bin sync failure' })
            await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [moved.entry] })
            await expect(manager.read(moved.entry.id, workspaceDir)).resolves.toMatchObject({
                success: true,
                content: Buffer.from('keep the payload').toString('base64'),
            })
        } finally {
            await cleanup()
        }
    })

    it('does not publish a partial restore target when staged copying fails', async () => {
        try {
            const filePath = join(workspaceDir, 'staged-restore-failure.txt')
            await writeFile(filePath, 'keep the payload')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.rejectSync = true
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toMatchObject({ success: false, error: 'Simulated recycle-bin sync failure' })
            await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
            await expect(readdir(workspaceDir)).resolves.not.toContain(expect.stringMatching(/^\.hapi-restore-/))
            recycleBinIoHarness.rejectSync = false
            await expect(manager.read(moved.entry.id, workspaceDir)).resolves.toMatchObject({
                success: true,
                content: Buffer.from('keep the payload').toString('base64'),
            })
        } finally {
            await cleanup()
        }
    })

    it('keeps the existing target until a staged overwrite restore is ready', async () => {
        try {
            const filePath = join(workspaceDir, 'staged-overwrite.txt')
            await writeFile(filePath, 'original')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            await writeFile(filePath, 'current')

            recycleBinIoHarness.rejectSync = true
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'overwrite')
            expect(restored).toMatchObject({ success: false, error: 'Simulated recycle-bin sync failure' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('current')
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [moved.entry] })
            await expect(readdir(workspaceDir)).resolves.not.toContain(expect.stringMatching(/^\.hapi-restore-/))
        } finally {
            await cleanup()
        }
    })

    it('keeps a copied restore destination after source unlink when parent sync fails', async () => {
        try {
            const filePath = join(workspaceDir, 'source-sync-failure.txt')
            await writeFile(filePath, 'restore destination')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.directorySyncCalls = 0
            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 3
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('restore destination')
        } finally {
            await cleanup()
        }
    })

    it('keeps the recycle payload after a staged replacement is installed but root sync fails', async () => {
        try {
            const filePath = join(workspaceDir, 'replacement-sync-failure.txt')
            await writeFile(filePath, 'original')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')
            await writeFile(filePath, 'current')

            recycleBinIoHarness.directorySyncCalls = 0
            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 3
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'overwrite')
            expect(restored).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('original')
            recycleBinIoHarness.rejectDirectorySync = false
            await expect(manager.read(moved.entry.id, workspaceDir)).resolves.toMatchObject({
                success: true,
                content: Buffer.from('original').toString('base64'),
            })
        } finally {
            await cleanup()
        }
    })

    it('refuses to restore a recycle entry whose payload was changed', async () => {
        try {
            const filePath = join(workspaceDir, 'tampered.txt')
            await writeFile(filePath, 'original')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            await writeFile(join(getRecycleBinRoot(homeDir), moved.entry.id, 'payload'), 'tampered')
            const restored = await manager.restore(moved.entry.id, workspaceDir, 'fail')
            expect(restored).toMatchObject({ success: false, error: 'Recycle-bin entry payload changed' })
            await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await cleanup()
        }
    })

    it('expires entries during normal access and removes their local payloads', async () => {
        try {
            let now = 0
            const filePath = join(workspaceDir, 'expired.txt')
            await writeFile(filePath, 'expired')
            const manager = createManager(homeDir, () => now, 1)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            now = DAY_MS
            const listed = await manager.list(workspaceDir)
            expect(listed).toMatchObject({ success: true, entries: [] })
            await expect(stat(join(getRecycleBinRoot(homeDir), moved.entry.id))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await cleanup()
        }
    })

    it('does not report purge success before the recycle root sync completes', async () => {
        try {
            const filePath = join(workspaceDir, 'purge-sync-failure.txt')
            await writeFile(filePath, 'purge me')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 2
            const purged = await manager.purge(moved.entry.id, workspaceDir)
            expect(purged).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            recycleBinIoHarness.rejectDirectorySync = false
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [] })
        } finally {
            await cleanup()
        }
    })

    it('does not report empty-bin success before the recycle root sync completes', async () => {
        try {
            const filePath = join(workspaceDir, 'empty-sync-failure.txt')
            await writeFile(filePath, 'empty me')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            recycleBinIoHarness.rejectDirectorySync = true
            recycleBinIoHarness.directorySyncFailureAt = 2
            const emptied = await manager.empty(workspaceDir, [moved.entry.id])
            expect(emptied).toMatchObject({ success: false, error: 'Simulated recycle-bin directory sync failure' })
            recycleBinIoHarness.rejectDirectorySync = false
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({ success: true, entries: [] })
        } finally {
            await cleanup()
        }
    })

    it('rejects out-of-scope, directory, protected .git, and escaping symlink paths', async () => {
        try {
            const outsideDir = await createTempDir('hapi-recycle-outside')
            try {
                await writeFile(join(outsideDir, 'outside.txt'), 'outside')
                await mkdir(join(workspaceDir, '.git'), { recursive: true })
                await writeFile(join(workspaceDir, '.git', 'config'), 'secret')
                await writeFile(join(workspaceDir, 'folder.txt'), 'not a directory')
                await mkdir(join(workspaceDir, 'directory'))
                const manager = createManager(homeDir)

                expect((await manager.moveFile(join('..', outsideDir.split(sep).pop() ?? 'outside', 'outside.txt'), workspaceDir)).success).toBe(false)
                expect((await manager.moveFile('directory', workspaceDir)).success).toBe(false)
                expect((await manager.moveFile('.git/config', workspaceDir)).success).toBe(false)

                try {
                    await symlink(join(outsideDir, 'outside.txt'), join(workspaceDir, 'escape.txt'))
                } catch {
                    return
                }
                expect((await manager.moveFile('escape.txt', workspaceDir)).success).toBe(false)
            } finally {
                await rm(outsideDir, { recursive: true, force: true })
            }
        } finally {
            await cleanup()
        }
    })

    it('protects all HAPI home state when the home is nested in the working directory', async () => {
        try {
            const nestedHome = join(workspaceDir, '.hapi-home')
            await mkdir(nestedHome)
            const settingsPath = join(nestedHome, 'settings.json')
            await writeFile(settingsPath, '{"secret":true}')
            const manager = createManager(nestedHome)

            const result = await manager.moveFile(join('.hapi-home', 'settings.json'), workspaceDir)
            expect(result).toMatchObject({ success: false, error: 'File path is outside the authorized working directory' })
            await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"secret":true}')
        } finally {
            await cleanup()
        }
    })

    it('does not reconcile staging files through a replaced parent symlink', async () => {
        let outsideDir = ''
        const parentPath = join(workspaceDir, 'replaceable-parent')
        try {
            outsideDir = await createTempDir('hapi-recycle-replaced-parent')
            await mkdir(parentPath)
            const filePath = join(parentPath, 'original.txt')
            await writeFile(filePath, 'original contents')
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            await rm(parentPath, { recursive: true, force: true })
            try {
                await symlink(outsideDir, parentPath, process.platform === 'win32' ? 'junction' : undefined)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return
                throw error
            }

            const stagingPath = join(outsideDir, `.hapi-restore-${moved.entry.id}.tmp`)
            await writeFile(stagingPath, 'unrelated outside file')
            await expect(manager.list(workspaceDir)).resolves.toMatchObject({
                success: true,
                entries: [moved.entry],
            })
            await expect(readFile(stagingPath, 'utf8')).resolves.toBe('unrelated outside file')
        } finally {
            await rm(parentPath, { recursive: true, force: true })
            if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
            await cleanup()
        }
    })

    it('rejects a symlinked recycle-bin root before changing the target mode', async () => {
        let outsideDir = ''
        try {
            outsideDir = await createTempDir('hapi-recycle-symlink-target')
            const recycleRoot = getRecycleBinRoot(homeDir)
            try {
                await symlink(outsideDir, recycleRoot, process.platform === 'win32' ? 'junction' : undefined)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return
                throw error
            }

            const beforeMode = (await stat(outsideDir)).mode
            const result = await createManager(homeDir).list(workspaceDir)
            expect(result).toMatchObject({ success: false, error: 'HAPI Recycle Bin storage is invalid' })
            expect((await stat(outsideDir)).mode).toBe(beforeMode)
        } finally {
            if (outsideDir) await rm(outsideDir, { recursive: true, force: true })
            await rm(getRecycleBinRoot(homeDir), { recursive: true, force: true })
            await cleanup()
        }
    })

    it('protects the physical recycle root when HAPI home is a directory symlink', async () => {
        let realHome = ''
        let linkParent = ''
        let linkedHome = ''
        try {
            realHome = await createTempDir('hapi-recycle-real-home')
            linkParent = await createTempDir('hapi-recycle-home-link-parent')
            linkedHome = join(linkParent, 'home')
            try {
                await symlink(realHome, linkedHome, process.platform === 'win32' ? 'junction' : undefined)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return
                throw error
            }

            const protectedWorkspace = join(realHome, 'recycle-bin', 'workspace')
            await mkdir(protectedWorkspace, { recursive: true })
            const filePath = join(protectedWorkspace, 'protected.txt')
            await writeFile(filePath, 'protected')

            const result = await createManager(linkedHome).moveFile(filePath, protectedWorkspace)
            expect(result).toMatchObject({ success: false, error: 'HAPI Recycle Bin storage is protected' })
            await expect(readFile(filePath, 'utf8')).resolves.toBe('protected')
        } finally {
            if (linkedHome) await rm(linkedHome, { recursive: true, force: true })
            if (realHome) await rm(realHome, { recursive: true, force: true })
            if (linkParent) await rm(linkParent, { recursive: true, force: true })
            await cleanup()
        }
    })

    it('supports permanent purge and emptying only entries visible from the current scope', async () => {
        try {
            const firstPath = join(workspaceDir, 'first.txt')
            const secondPath = join(workspaceDir, 'second.txt')
            const thirdPath = join(workspaceDir, 'third.txt')
            await writeFile(firstPath, 'first')
            await writeFile(secondPath, 'second')
            const manager = createManager(homeDir)
            const first = await manager.moveFile(firstPath, workspaceDir)
            const second = await manager.moveFile(secondPath, workspaceDir)
            if (!first.success || !first.entry || !second.success || !second.entry) throw new Error('move did not return entries')

            expect(await manager.purge(first.entry.id, workspaceDir)).toEqual({ success: true })
            expect((await manager.list(workspaceDir)).entries).toEqual([second.entry])
            const confirmedEntryIds = [second.entry.id]
            await writeFile(thirdPath, 'third')
            const third = await manager.moveFile(thirdPath, workspaceDir)
            if (!third.success || !third.entry) throw new Error('move did not return a third entry')
            expect(await manager.empty(workspaceDir, confirmedEntryIds)).toEqual({ success: true, deletedCount: 1 })
            expect((await manager.list(workspaceDir)).entries).toEqual([third.entry])
            expect(await manager.empty(workspaceDir, [third.entry.id])).toEqual({ success: true, deletedCount: 1 })
            expect((await manager.list(workspaceDir)).entries).toHaveLength(0)
        } finally {
            await cleanup()
        }
    })

    it('rejects preview reads above the bounded preview size', async () => {
        try {
            const filePath = join(workspaceDir, 'large.bin')
            await writeFile(filePath, Buffer.alloc(MAX_RECYCLE_BIN_PREVIEW_BYTES + 1, 1))
            const manager = createManager(homeDir)
            const moved = await manager.moveFile(filePath, workspaceDir)
            if (!moved.success || !moved.entry) throw new Error('move did not return an entry')

            const preview = await manager.read(moved.entry.id, workspaceDir)
            expect(preview).toMatchObject({ success: false, size: MAX_RECYCLE_BIN_PREVIEW_BYTES + 1 })
            expect(preview.content).toBeUndefined()
        } finally {
            await cleanup()
        }
    })
})
