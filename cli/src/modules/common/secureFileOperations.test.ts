import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    fileIdentityFromStats,
    getSecureDirectoryIdentity,
    secureRename,
    secureUnlink,
} from './secureFileOperations'

async function createTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `${prefix}-`))
}

describe('secureFileOperations', () => {
    let root: string
    // Vitest runs through Node in this repository; the native Bun path is
    // exercised separately with the Bun smoke command used for this module.
    const secureIt = process.versions.bun ? it : it.skip

    beforeEach(async () => {
        root = await createTempDir('hapi-secure-files')
    })

    afterEach(async () => {
        await rm(root, { recursive: true, force: true })
    })

    it('preserves bigint file identities without numeric rounding', () => {
        expect(fileIdentityFromStats({ dev: 1n, ino: 9_007_199_254_740_993n })).toEqual({
            dev: '1',
            ino: '9007199254740993',
        })
    })

    secureIt('renames and unlinks through a pinned directory', async () => {
        const sourcePath = join(root, 'source.txt')
        const targetPath = join(root, 'target.txt')
        await writeFile(sourcePath, 'secure move')
        const directoryIdentity = await getSecureDirectoryIdentity(root)
        const sourceIdentity = fileIdentityFromStats(await stat(sourcePath))

        await secureRename(sourcePath, targetPath, {
            sourceDirectoryIdentity: directoryIdentity,
            targetDirectoryIdentity: directoryIdentity,
            sourceFileIdentity: sourceIdentity,
        })
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('secure move')

        await secureUnlink(targetPath, directoryIdentity, sourceIdentity)
        await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    secureIt('rejects a replaced directory identity before mutating the source', async () => {
        const sourcePath = join(root, 'source.txt')
        const otherDirectory = await createTempDir('hapi-secure-other')
        try {
            await writeFile(sourcePath, 'must remain')
            const sourceIdentity = fileIdentityFromStats(await stat(sourcePath))
            const otherIdentity = await getSecureDirectoryIdentity(otherDirectory)

            await expect(secureRename(sourcePath, join(root, 'target.txt'), {
                sourceDirectoryIdentity: otherIdentity,
                targetDirectoryIdentity: otherIdentity,
                sourceFileIdentity: sourceIdentity,
            })).rejects.toThrow('parent changed')
            await expect(readFile(sourcePath, 'utf8')).resolves.toBe('must remain')
        } finally {
            await rm(otherDirectory, { recursive: true, force: true })
        }
    })
})
