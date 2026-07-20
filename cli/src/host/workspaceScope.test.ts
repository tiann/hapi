import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceScope } from './workspaceScope'

const created: string[] = []

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix))
    created.push(path)
    return path
}

describe('WorkspaceScope', () => {
    it('accepts paths inside roots and rejects traversal and root mutation', async () => {
        const root = await temp('hapi-scope-root-')
        const outside = await temp('hapi-scope-outside-')
        const file = join(root, 'file.txt')
        const dotDotName = join(root, '..cache')
        await writeFile(file, 'ok')
        await mkdir(dotDotName)
        const scope = await WorkspaceScope.create([root])

        await expect(scope.resolveReadable(file)).resolves.toBe(file)
        await expect(scope.resolveReadable(dotDotName)).resolves.toBe(dotDotName)
        await expect(scope.resolveReadable(outside)).rejects.toThrow(/outside configured workspace roots/)
        await expect(scope.resolveMutableExisting(root)).rejects.toThrow(/roots cannot be modified/)
    })

    it('rejects symlink escapes for reads, writes, and new destinations', async () => {
        const root = await temp('hapi-scope-link-root-')
        const outside = await temp('hapi-scope-link-outside-')
        await mkdir(join(outside, 'nested'))
        await writeFile(join(outside, 'secret.txt'), 'secret')
        await symlink(outside, join(root, 'escape'), 'dir')
        await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'))
        const scope = await WorkspaceScope.create([root])

        await expect(scope.resolveReadable(join(root, 'escape'))).rejects.toThrow(/outside configured workspace roots/)
        await expect(scope.resolveWritableExisting(join(root, 'secret-link'))).rejects.toThrow(/outside configured workspace roots/)
        await expect(scope.resolveDestination(join(root, 'escape', 'new.txt'))).rejects.toThrow(/outside configured workspace roots/)
    })

    it('protects Git metadata even when .git is a symlink', async () => {
        const root = await temp('hapi-scope-git-root-')
        await mkdir(join(root, 'metadata'))
        await writeFile(join(root, 'metadata', 'config'), 'x')
        await symlink(join(root, 'metadata'), join(root, '.git'), 'dir')
        const scope = await WorkspaceScope.create([root])

        await expect(scope.resolveMutableExisting(join(root, '.git', 'config'))).rejects.toThrow(/Git metadata/)
        await expect(scope.resolveWritableExisting(join(root, '.git', 'config'))).rejects.toThrow(/Git metadata/)
    })
})
