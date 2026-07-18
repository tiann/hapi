import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePath } from './pathSecurity'

describe('validatePath', () => {
    let parent: string
    let workingDirectory: string
    let outsideDirectory: string

    beforeEach(async () => {
        parent = mkdtempSync(join(tmpdir(), 'hapi-path-security-'))
        workingDirectory = join(parent, 'workspace')
        outsideDirectory = join(parent, 'outside')
        await mkdir(join(workingDirectory, 'src'), { recursive: true })
        await mkdir(outsideDirectory, { recursive: true })
        workingDirectory = await realpath(workingDirectory)
        outsideDirectory = await realpath(outsideDirectory)
        await writeFile(join(workingDirectory, 'file.txt'), 'root file')
        await writeFile(join(workingDirectory, 'src', 'file.txt'), 'source file')
        await writeFile(join(outsideDirectory, 'secret.txt'), 'outside secret')
    })

    afterEach(() => {
        rmSync(parent, { recursive: true, force: true })
    })

    it('allows existing paths within the real working directory', async () => {
        const absolute = await validatePath(join(workingDirectory, 'file.txt'), workingDirectory)
        const relative = await validatePath('./src/file.txt', workingDirectory)

        expect(absolute).toEqual({ valid: true, resolvedPath: join(workingDirectory, 'file.txt') })
        expect(relative).toEqual({ valid: true, resolvedPath: join(workingDirectory, 'src', 'file.txt') })
    })

    it('only allows a missing final leaf when creation was explicitly requested', async () => {
        const rejected = await validatePath('new.txt', workingDirectory)
        const allowed = await validatePath('new.txt', workingDirectory, { allowMissingLeaf: true })

        expect(rejected.valid).toBe(false)
        expect(allowed).toEqual({ valid: true, resolvedPath: join(workingDirectory, 'new.txt') })
    })

    it('rejects absolute and traversal paths outside the working directory', async () => {
        const absolute = await validatePath(join(outsideDirectory, 'secret.txt'), workingDirectory)
        const traversal = await validatePath('../outside/secret.txt', workingDirectory)

        expect(absolute.valid).toBe(false)
        expect(absolute.error).toContain('outside the working directory')
        expect(traversal.valid).toBe(false)
        expect(traversal.error).toContain('outside the working directory')
    })

    it('does not treat sibling directory names as workspace descendants', async () => {
        const sibling = `${workingDirectory}-sibling`
        await mkdir(sibling)
        await writeFile(join(sibling, 'file.txt'), 'sibling')

        const result = await validatePath(join(sibling, 'file.txt'), workingDirectory)

        expect(result.valid).toBe(false)
    })

    it('allows the working directory itself', async () => {
        expect(await validatePath('.', workingDirectory)).toEqual({
            valid: true,
            resolvedPath: resolve(workingDirectory),
        })
        expect((await validatePath(workingDirectory, workingDirectory)).valid).toBe(true)
    })

    it.skipIf(process.platform === 'win32')('rejects every symlink component below the workspace', async () => {
        await symlink(join(workingDirectory, 'file.txt'), join(workingDirectory, 'internal-link'))
        await symlink(outsideDirectory, join(workingDirectory, 'outside-link'))

        expect((await validatePath('internal-link', workingDirectory)).valid).toBe(false)
        expect((await validatePath('outside-link/secret.txt', workingDirectory)).valid).toBe(false)
    })

    it.skipIf(process.platform === 'win32')('accepts a symlinked workspace root while still returning its real path', async () => {
        const workspaceAlias = join(parent, 'workspace-alias')
        await symlink(workingDirectory, workspaceAlias)

        const result = await validatePath('file.txt', workspaceAlias)

        expect(result).toEqual({ valid: true, resolvedPath: join(workingDirectory, 'file.txt') })
    })
})
