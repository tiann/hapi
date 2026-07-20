import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileManager } from './fileManager'
import { WorkspaceScope } from './workspaceScope'

const created: string[] = []
const context = { signal: new AbortController().signal, report: () => {} }

afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createManager(): Promise<{ root: string; scope: WorkspaceScope; manager: FileManager }> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-files-'))
    created.push(root)
    const scope = await WorkspaceScope.create([root])
    return { root, scope, manager: new FileManager(scope) }
}

describe('FileManager', () => {
    it('creates, lists, copies, moves, and deletes files and directories', async () => {
        const { root, manager } = await createManager()
        const sourceDir = join(root, 'source')
        const targetDir = join(root, 'target')
        await manager.execute({ kind: 'create-directory', path: sourceDir }, context)
        await manager.execute({ kind: 'create-directory', path: targetDir }, context)
        await manager.execute({ kind: 'create-file', path: join(sourceDir, 'a.txt'), content: 'hello' }, context)
        await writeFile(join(sourceDir, '.hidden'), 'hidden')

        expect((await manager.list(sourceDir, false)).entries?.map((entry) => entry.name)).toEqual(['a.txt'])
        expect((await manager.list(sourceDir, true)).entries?.map((entry) => entry.name)).toEqual(['.hidden', 'a.txt'])

        await manager.execute({ kind: 'copy', sources: [join(sourceDir, 'a.txt')], destination: targetDir, conflict: 'fail' }, context)
        expect(await readFile(join(targetDir, 'a.txt'), 'utf8')).toBe('hello')

        const moveDir = join(root, 'moved')
        await mkdir(moveDir)
        await manager.execute({ kind: 'move', sources: [join(targetDir, 'a.txt')], destination: moveDir, conflict: 'fail' }, context)
        expect(await readFile(join(moveDir, 'a.txt'), 'utf8')).toBe('hello')

        await manager.execute({ kind: 'delete', paths: [moveDir] }, context)
        await expect(stat(moveDir)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('uploads binary files into the selected workspace directory without overwriting by default', async () => {
        const { root, manager } = await createManager()
        const bytes = Buffer.from([0, 255, 1, 2])

        const uploaded = await manager.upload({
            directory: root,
            name: 'archive.bin',
            contentBase64: bytes.toString('base64'),
            conflict: 'fail'
        })
        expect(uploaded).toMatchObject({ success: true, path: join(root, 'archive.bin'), size: 4 })
        expect(await readFile(join(root, 'archive.bin'))).toEqual(bytes)

        const duplicate = await manager.upload({
            directory: root,
            name: 'archive.bin',
            contentBase64: bytes.toString('base64'),
            conflict: 'new-copy'
        })
        expect(duplicate.path).toBe(join(root, 'archive (copy).bin'))
        const empty = await manager.upload({
            directory: root,
            name: 'empty.txt',
            contentBase64: '',
            conflict: 'fail'
        })
        expect(empty).toMatchObject({ success: true, size: 0 })
        expect((await stat(join(root, 'empty.txt'))).size).toBe(0)
        await expect(manager.upload({
            directory: root,
            name: '../outside.bin',
            contentBase64: bytes.toString('base64'),
            conflict: 'fail'
        })).rejects.toThrow(/outside configured workspace roots/)
    })

    it('fails on conflicts and protects .git', async () => {
        const { root, manager } = await createManager()
        await mkdir(join(root, 'a'))
        await mkdir(join(root, 'b'))
        await mkdir(join(root, '.git'))
        await writeFile(join(root, 'a', 'same.txt'), 'a')
        await writeFile(join(root, 'b', 'same.txt'), 'b')

        await expect(manager.execute({ kind: 'copy', sources: [join(root, 'a', 'same.txt')], destination: join(root, 'b'), conflict: 'fail' }, context)).rejects.toThrow(/already exists/)
        await expect(manager.execute({ kind: 'delete', paths: [join(root, '.git')] }, context)).rejects.toThrow(/Git metadata/)
    })

    it('hides and rejects readable Git metadata', async () => {
        const { root, manager } = await createManager()
        const gitDirectory = join(root, '.git')
        const gitConfig = join(gitDirectory, 'config')
        await mkdir(gitDirectory)
        await writeFile(gitConfig, '[remote "origin"]')

        expect((await manager.list(root, true)).entries?.map((entry) => entry.name)).not.toContain('.git')
        await expect(manager.list(gitDirectory, true)).rejects.toThrow(/Git metadata/)
        await expect(manager.readPreview(gitConfig)).rejects.toThrow(/Git metadata/)
    })

    it('refuses uploads through a .git directory symlink', async () => {
        const { root, manager } = await createManager()
        const metadata = join(root, 'metadata')
        await mkdir(metadata)
        await symlink(metadata, join(root, '.git'), 'dir')

        await expect(manager.upload({
            directory: join(root, '.git'),
            name: 'config',
            contentBase64: Buffer.from('[core]').toString('base64'),
            conflict: 'fail'
        })).rejects.toThrow(/Git metadata/)

        await expect(stat(join(metadata, 'config'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    for (const kind of ['copy', 'move'] as const) {
        it(`refuses to ${kind} into a .git directory symlink`, async () => {
            const { root, manager } = await createManager()
            const metadata = join(root, 'metadata')
            const source = join(root, `${kind}.txt`)
            const operation = {
                kind,
                sources: [source],
                destination: join(root, '.git'),
                conflict: 'fail' as const
            }
            await mkdir(metadata)
            await writeFile(source, kind)
            await symlink(metadata, join(root, '.git'), 'dir')

            await expect(manager.execute(operation, context)).rejects.toThrow(/Git metadata/)
            await expect(manager.lockKeys(operation)).rejects.toThrow(/Git metadata/)
            expect(await readFile(source, 'utf8')).toBe(kind)
            await expect(stat(join(metadata, `${kind}.txt`))).rejects.toMatchObject({ code: 'ENOENT' })
        })
    }

    for (const kind of ['copy', 'move'] as const) {
        it(`rejects Git metadata inserted while recursively ${kind === 'copy' ? 'copying' : 'moving'}`, async () => {
            const { root, manager } = await createManager()
            const source = join(root, 'source')
            const destination = join(root, 'destination')
            const gitConfig = join(source, '.git', 'config')
            await mkdir(source)
            await mkdir(destination)
            await writeFile(join(source, 'file.txt'), 'source')
            let inserted = false
            const raceContext = {
                signal: context.signal,
                report: () => {
                    if (inserted) return
                    mkdirSync(join(source, '.git'))
                    writeFileSync(gitConfig, '[core]')
                    inserted = true
                }
            }

            await expect(manager.execute({
                kind,
                sources: [source],
                destination,
                conflict: 'fail'
            }, raceContext)).rejects.toThrow(/Git metadata/)

            expect(inserted).toBe(true)
            expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
            await expect(stat(join(destination, 'source', '.git', 'config'))).rejects.toMatchObject({ code: 'ENOENT' })
        })
    }

    it('rejects Git metadata inserted immediately before recursive deletion', async () => {
        const { root, manager } = await createManager()
        const source = join(root, 'source')
        const gitConfig = join(source, '.git', 'config')
        await mkdir(source)
        await writeFile(join(source, 'file.txt'), 'source')
        const raceContext = {
            signal: context.signal,
            report: () => {
                mkdirSync(join(source, '.git'))
                writeFileSync(gitConfig, '[core]')
            }
        }

        await expect(manager.execute({ kind: 'delete', paths: [source] }, raceContext)).rejects.toThrow(/Git metadata/)
        expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
    })

    it('rolls back a directory move when Git metadata appears before source removal', async () => {
        const { root, scope, manager } = await createManager()
        const source = join(root, 'source')
        const destination = join(root, 'destination')
        const gitConfig = join(source, '.git', 'config')
        await mkdir(source)
        await mkdir(destination)
        await writeFile(join(source, 'file.txt'), 'source')
        const resolveMutable = scope.resolveMutableExisting.bind(scope)
        let sourceResolutions = 0
        vi.spyOn(scope, 'resolveMutableExisting').mockImplementation(async (path) => {
            const resolved = await resolveMutable(path)
            if (resolved === source && ++sourceResolutions === 2) {
                await mkdir(join(source, '.git'))
                await writeFile(gitConfig, '[core]')
            }
            return resolved
        })

        await expect(manager.execute({
            kind: 'move',
            sources: [source],
            destination,
            conflict: 'fail'
        }, context)).rejects.toThrow(/Git metadata/)

        expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
        await expect(stat(join(destination, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('preserves Git metadata inserted after recursive deletion starts', async () => {
        const { root, scope, manager } = await createManager()
        const source = join(root, 'source')
        const child = join(source, 'file.txt')
        const gitConfig = join(source, '.git', 'config')
        await mkdir(source)
        await writeFile(child, 'source')
        const resolveMutable = scope.resolveMutableExisting.bind(scope)
        vi.spyOn(scope, 'resolveMutableExisting').mockImplementation(async (path) => {
            const resolved = await resolveMutable(path)
            if (resolved === child) {
                await mkdir(join(source, '.git'))
                await writeFile(gitConfig, '[core]')
            }
            return resolved
        })

        await expect(manager.execute({ kind: 'delete', paths: [source] }, context)).rejects.toThrow(/Git metadata/)
        expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
    })

    for (const kind of ['copy', 'move', 'delete'] as const) {
        it(`refuses to ${kind} a directory containing nested Git metadata`, async () => {
            const { root, manager } = await createManager()
            const repository = join(root, 'repository')
            const gitConfig = join(repository, '.git', 'config')
            await mkdir(join(repository, '.git'), { recursive: true })
            await writeFile(gitConfig, '[core]')

            if (kind === 'delete') {
                await expect(manager.execute({ kind, paths: [repository] }, context)).rejects.toThrow(/Git metadata/)
            } else {
                const destination = join(root, 'destination')
                await mkdir(destination)
                await expect(manager.execute({ kind, sources: [repository], destination, conflict: 'fail' }, context)).rejects.toThrow(/Git metadata/)
            }

            expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
        })
    }

    it('refuses to replace a directory containing nested Git metadata', async () => {
        const { root, manager } = await createManager()
        const source = join(root, 'source')
        const destination = join(root, 'destination')
        const existing = join(destination, 'source')
        const gitConfig = join(existing, '.git', 'config')
        await mkdir(source)
        await writeFile(join(source, 'file.txt'), 'source')
        await mkdir(join(existing, '.git'), { recursive: true })
        await writeFile(gitConfig, '[core]')

        await expect(manager.execute({
            kind: 'copy',
            sources: [source],
            destination,
            conflict: 'replace'
        }, context)).rejects.toThrow(/Git metadata/)

        expect(await readFile(gitConfig, 'utf8')).toBe('[core]')
    })

    it('preflights every conflict before copying any source', async () => {
        const { root, manager } = await createManager()
        const first = join(root, 'first.txt')
        const second = join(root, 'second.txt')
        const destination = join(root, 'destination')
        await writeFile(first, 'first')
        await writeFile(second, 'second')
        await mkdir(destination)
        await writeFile(join(destination, 'second.txt'), 'existing')

        await expect(manager.execute({
            kind: 'copy',
            sources: [first, second],
            destination,
            conflict: 'fail'
        }, context)).rejects.toThrow(/second\.txt/)
        await expect(stat(join(destination, 'first.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects overlapping move sources before changing the filesystem', async () => {
        const { root, manager } = await createManager()
        const parent = join(root, 'parent')
        const child = join(parent, '..child.txt')
        const destination = join(root, 'destination')
        await mkdir(parent)
        await writeFile(child, 'child')

        await expect(manager.execute({
            kind: 'move',
            sources: [parent, child],
            destination,
            conflict: 'fail',
            createDestination: true
        }, context)).rejects.toThrow(/overlap/)

        expect(await readFile(child, 'utf8')).toBe('child')
        await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects overlapping delete paths before changing the filesystem', async () => {
        const { root, manager } = await createManager()
        const parent = join(root, 'parent')
        const child = join(parent, 'child.txt')
        await mkdir(parent)
        await writeFile(child, 'child')

        await expect(manager.execute({
            kind: 'delete',
            paths: [parent, child]
        }, context)).rejects.toThrow(/overlap/)

        expect(await readFile(child, 'utf8')).toBe('child')
    })

    it('creates a requested destination and resolves collisions by copy or skip', async () => {
        const { root, manager } = await createManager()
        const source = join(root, 'source.txt')
        const destination = join(root, 'nested', 'target')
        await writeFile(source, 'source')
        await mkdir(destination, { recursive: true })
        await writeFile(join(destination, 'source.txt'), 'existing')

        await manager.execute({
            kind: 'copy',
            sources: [source],
            destination,
            conflict: 'new-copy'
        }, context)
        expect(await readFile(join(destination, 'source (copy).txt'), 'utf8')).toBe('source')

        const replaced = await manager.execute({
            kind: 'copy',
            sources: [source],
            destination,
            conflict: 'replace'
        }, context)
        expect(replaced).toMatchObject({ paths: [join(destination, 'source.txt')], replaced: [join(destination, 'source.txt')] })
        expect(await readFile(join(destination, 'source.txt'), 'utf8')).toBe('source')

        await manager.execute({
            kind: 'move',
            sources: [source],
            destination,
            conflict: 'skip'
        }, context)
        expect(await readFile(source, 'utf8')).toBe('source')

        const createdDestination = join(root, 'created', 'target')
        await manager.execute({
            kind: 'copy',
            sources: [source],
            destination: createdDestination,
            conflict: 'fail',
            createDestination: true
        }, context)
        expect(await readFile(join(createdDestination, 'source.txt'), 'utf8')).toBe('source')
    })

    it('applies the selected conflict policy when copying into the source directory', async () => {
        const { root, manager } = await createManager()
        const source = join(root, 'source.txt')
        await writeFile(source, 'source')

        const copied = await manager.execute({
            kind: 'copy',
            sources: [source],
            destination: root,
            conflict: 'new-copy'
        }, context)
        expect(copied).toMatchObject({ paths: [join(root, 'source (copy).txt')], skipped: [] })
        expect(await readFile(join(root, 'source (copy).txt'), 'utf8')).toBe('source')

        const skipped = await manager.execute({
            kind: 'copy',
            sources: [source],
            destination: root,
            conflict: 'skip'
        }, context)
        expect(skipped).toMatchObject({ paths: [], skipped: [source] })

        const replace = await manager.execute({
            kind: 'copy',
            sources: [source],
            destination: root,
            conflict: 'replace'
        }, context)
        expect(replace).toMatchObject({ paths: [], skipped: [source] })
        await expect(manager.execute({
            kind: 'copy',
            sources: [source],
            destination: root,
            conflict: 'fail'
        }, context)).rejects.toThrow(/already exists/)
    })

    it('reads previewable files and prevents stale editor writes', async () => {
        const { root, manager } = await createManager()
        const file = join(root, 'notes.md')
        await writeFile(file, '# First version')

        const preview = await manager.readPreview(file)
        expect(preview).toMatchObject({ kind: 'text', text: '# First version' })

        const saved = await manager.writeText({
            path: file,
            content: '# Updated',
            expectedModified: preview.modified,
            expectedSize: preview.size
        })
        expect(saved.text).toBe('# Updated')

        await writeFile(file, '# External change')
        await expect(manager.writeText({
            path: file,
            content: '# Stale overwrite',
            expectedModified: preview.modified,
            expectedSize: preview.size
        })).rejects.toThrow(/changed since it was opened/i)
    })

    it.skipIf(process.platform === 'win32')('does not preview a file retargeted after scope validation', async () => {
        const { root, scope, manager } = await createManager()
        const outside = await mkdtemp(join(tmpdir(), 'hapi-preview-outside-'))
        created.push(outside)
        const file = join(root, 'notes.md')
        const secret = join(outside, 'secret.md')
        await writeFile(file, 'workspace content')
        await writeFile(secret, 'outside secret')
        const resolveReadable = scope.resolveReadableNonGitMetadata.bind(scope)
        vi.spyOn(scope, 'resolveReadableNonGitMetadata').mockImplementationOnce(async (path) => {
            const resolved = await resolveReadable(path)
            await rm(resolved)
            await symlink(secret, resolved)
            return resolved
        })

        await expect(manager.readPreview(file)).rejects.toThrow(/outside configured workspace roots|changed while being previewed/)
    })
})
