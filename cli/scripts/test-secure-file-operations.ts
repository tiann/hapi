import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
    fileIdentityFromStats,
    fileIdentityFromPath,
    getSecureDirectoryIdentity,
    openSecureStagingFile,
    secureRemoveQuarantinedFile,
    secureRename,
    secureUnlink,
    type SecureQuarantine,
} from '../src/modules/common/secureFileOperations'
import { RecycleBinManager } from '../src/modules/common/recycleBin'

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

async function assertRejects(operation: Promise<unknown>, message: string): Promise<void> {
    try {
        await operation
    } catch {
        return
    }
    throw new Error(message)
}

async function testPosix(root: string): Promise<void> {
    const workspace = join(root, 'workspace')
    const other = join(root, 'other')
    await mkdir(workspace)
    await mkdir(other)

    const directoryIdentity = await getSecureDirectoryIdentity(workspace)
    const otherDirectoryIdentity = await getSecureDirectoryIdentity(other)
    const sourcePath = join(workspace, 'source.txt')
    const targetPath = join(workspace, 'target.txt')
    await writeFile(sourcePath, 'secure rename')
    const sourceIdentity = await fileIdentityFromPath(sourcePath)

    await secureRename(sourcePath, targetPath, {
        sourceDirectoryIdentity: directoryIdentity,
        targetDirectoryIdentity: directoryIdentity,
        sourceFileIdentity: sourceIdentity,
    })
    await assertRejects(
        secureRename(targetPath, join(workspace, 'existing.txt'), {
            sourceDirectoryIdentity: otherDirectoryIdentity,
            targetDirectoryIdentity: otherDirectoryIdentity,
            sourceFileIdentity: sourceIdentity,
        }),
        'replaced directory identity was not rejected',
    )
    await secureUnlink(targetPath, directoryIdentity, sourceIdentity)

    const callbackFile = join(workspace, 'callback.txt')
    await writeFile(callbackFile, 'callback')
    const callbackIdentity = await fileIdentityFromPath(callbackFile)
    let prepared: SecureQuarantine | undefined
    await secureUnlink(callbackFile, directoryIdentity, callbackIdentity, {
        onQuarantinePrepared: async (quarantine) => {
            prepared = quarantine
        },
    })
    assert(prepared, 'POSIX cleanup did not expose its journaled quarantine')
    assert(!(await exists(prepared.path)), 'completed POSIX cleanup left a quarantine file')
    assert(!(await exists(dirname(prepared.path))), 'completed POSIX cleanup left a quarantine directory')

    const journalSource = join(workspace, 'journal-source.txt')
    const journalDirectory = join(workspace, `.hapi-recycle-quarantine-${randomUUID()}`)
    const journalPath = join(journalDirectory, basename(journalSource))
    await writeFile(journalSource, 'journaled payload')
    const journalIdentity = await fileIdentityFromPath(journalSource)
    await mkdir(journalDirectory, { mode: 0o700 })
    await rename(journalSource, journalPath)
    await secureRemoveQuarantinedFile({
        path: journalPath,
        directoryIdentity: await getSecureDirectoryIdentity(journalDirectory),
        parentDirectoryIdentity: directoryIdentity,
    }, journalIdentity)
    assert(!(await exists(journalDirectory)), 'journaled quarantine was not cleaned')

    const mismatchDirectory = join(workspace, `.hapi-recycle-quarantine-${randomUUID()}`)
    const mismatchPath = join(mismatchDirectory, 'mismatch.txt')
    const expectedPath = join(workspace, 'expected.txt')
    await writeFile(expectedPath, 'expected identity')
    const expectedIdentity = await fileIdentityFromPath(expectedPath)
    await mkdir(mismatchDirectory, { mode: 0o700 })
    await writeFile(mismatchPath, 'replacement must survive')
    await assertRejects(
        secureRemoveQuarantinedFile({
            path: mismatchPath,
            directoryIdentity: await getSecureDirectoryIdentity(mismatchDirectory),
            parentDirectoryIdentity: directoryIdentity,
        }, expectedIdentity),
        'quarantine identity mismatch was not rejected',
    )
    assert(await readFile(mismatchPath, 'utf8') === 'replacement must survive', 'replacement was removed after identity mismatch')
    await rm(mismatchDirectory, { recursive: true, force: true })

    const callbackFailurePath = join(workspace, 'callback-failure.txt')
    await writeFile(callbackFailurePath, 'must remain')
    const callbackFailureIdentity = await fileIdentityFromPath(callbackFailurePath)
    await assertRejects(
        secureUnlink(callbackFailurePath, directoryIdentity, callbackFailureIdentity, {
            onQuarantinePrepared: async () => {
                throw new Error('simulated journal failure')
            },
        }),
        'journal callback failure was not propagated',
    )
    assert(await readFile(callbackFailurePath, 'utf8') === 'must remain', 'journal failure detached the source')
    const leftovers = await readdir(workspace)
    assert(!leftovers.some((name) => name.startsWith('.hapi-recycle-quarantine-')), 'journal failure left an empty quarantine directory')
}

async function testWindows(root: string): Promise<void> {
    const workspace = join(root, 'workspace')
    const home = join(root, 'home')
    await mkdir(workspace)
    await mkdir(home)

    const directoryIdentity = await getSecureDirectoryIdentity(workspace)
    const sourcePath = join(workspace, 'source.txt')
    const targetPath = join(workspace, 'target.txt')
    await writeFile(sourcePath, 'secure rename')
    const sourceIdentity = await fileIdentityFromPath(sourcePath)
    await secureRename(sourcePath, targetPath, {
        sourceDirectoryIdentity: directoryIdentity,
        targetDirectoryIdentity: directoryIdentity,
        sourceFileIdentity: sourceIdentity,
    })
    await secureUnlink(targetPath, directoryIdentity, sourceIdentity)

    const stagingPath = join(workspace, '.hapi-stage.tmp')
    const staging = await openSecureStagingFile(stagingPath, directoryIdentity, 0o600)
    const content = Buffer.from('secure staging')
    await staging.write(content, 0, content.length, 0)
    await staging.sync()
    await staging.close()
    assert(await readFile(stagingPath, 'utf8') === 'secure staging', 'Windows secure staging content mismatch')
    await secureUnlink(stagingPath, directoryIdentity, await fileIdentityFromPath(stagingPath))

    const readonlyPath = join(workspace, 'readonly.txt')
    await writeFile(readonlyPath, 'readonly')
    await chmod(readonlyPath, 0o444)
    const manager = new RecycleBinManager(home, Date.now, async () => 30)
    const moved = await manager.moveFile(readonlyPath, workspace)
    assert(moved.success && moved.entry, 'Windows readonly move failed')
    const restored = await manager.restore(moved.entry.id, workspace, 'fail')
    assert(restored.success && restored.restoredPath === readonlyPath, 'Windows readonly restore failed')
    assert(((await stat(readonlyPath)).mode & 0o7777) === 0o444, 'Windows readonly mode was not preserved')
}

const root = await mkdtemp(join(tmpdir(), 'hapi-secure-file-operations-'))
try {
    const exactIdentity = fileIdentityFromStats({ dev: 1n, ino: 9_007_199_254_740_993n })
    assert(exactIdentity.ino === '9007199254740993', 'bigint file identity lost precision')
    if (process.platform === 'win32') {
        await testWindows(root)
    } else {
        await testPosix(root)
    }
    console.log(`secure file operations native smoke passed on ${process.platform}`)
} finally {
    await rm(root, { recursive: true, force: true })
}
