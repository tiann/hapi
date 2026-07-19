import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileManager } from './fileManager'
import { WorkspaceScope } from './workspaceScope'

const created: string[] = []
const context = { signal: new AbortController().signal, report: () => {} }

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createManager(): Promise<{ root: string; manager: FileManager }> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-files-'))
    created.push(root)
    return { root, manager: new FileManager(await WorkspaceScope.create([root])) }
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
})
