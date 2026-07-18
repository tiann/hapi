import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractTarArchivesSafely,
  validateArchiveEntry,
  type ArchiveEntryDescriptor,
} from './safeTarExtract'

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('safe tar extraction', () => {
  let root = ''
  let sentinel = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hapi-safe-tar-'))
    sentinel = join(root, 'outside-sentinel')
    await writeFile(sentinel, 'must remain unchanged')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function createArchive(
    name: string,
    entries: string[],
    populate: (source: string) => Promise<void>,
  ): Promise<string> {
    const source = join(root, `${name}-source`)
    const archive = join(root, `${name}.tar.gz`)
    await mkdir(source)
    await populate(source)
    // Keep gzip finalization inside the test call; async minizlib can emit a
    // late Z_STREAM_ERROR when a Vitest worker is torn down on current Node.
    tar.create({ cwd: source, file: archive, gzip: true, sync: true }, entries)
    return archive
  }

  async function expectRejectedWithoutOutsideWrite(
    archives: string[],
    expectedFiles: string[],
    pattern: RegExp,
  ): Promise<void> {
    const before = await sha256(sentinel)
    const destination = join(root, 'destination')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'previous'), 'preserve me')

    await expect(extractTarArchivesSafely({ archives, destination, expectedFiles })).rejects.toThrow(pattern)

    expect(await sha256(sentinel)).toBe(before)
    expect(await readFile(join(destination, 'previous'), 'utf8')).toBe('preserve me')
  }

  const invalidEntries: Array<[string, ArchiveEntryDescriptor, RegExp]> = [
    ['absolute POSIX path', { path: '/outside', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['Windows drive path', { path: 'C:/outside', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['Windows drive-relative path', { path: 'C:outside', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['Windows UNC path', { path: '//server/share', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['parent traversal', { path: '../outside', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['embedded parent traversal', { path: 'dir/../outside', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['empty segment', { path: 'dir//file', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['dot segment', { path: './file', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['backslash', { path: 'dir\\file', type: 'File', linkPath: null }, /unsafe archive path/i],
    ['symbolic link', { path: 'difft', type: 'SymbolicLink', linkPath: '../outside' }, /unsupported archive entry type/i],
    ['hard link', { path: 'difft', type: 'Link', linkPath: 'other' }, /unsupported archive entry type/i],
    ['character device', { path: 'difft', type: 'CharacterDevice', linkPath: null }, /unsupported archive entry type/i],
    ['block device', { path: 'difft', type: 'BlockDevice', linkPath: null }, /unsupported archive entry type/i],
    ['FIFO', { path: 'difft', type: 'FIFO', linkPath: null }, /unsupported archive entry type/i],
    ['link target on a file', { path: 'difft', type: 'File', linkPath: 'other' }, /archive link target/i],
  ]

  for (const [label, entry, pattern] of invalidEntries) {
    it(`rejects ${label}`, () => {
      expect(() => validateArchiveEntry(entry)).toThrow(pattern)
    })
  }

  it('accepts unchanged regular-file and directory paths', () => {
    expect(validateArchiveEntry({ path: 'difft', type: 'File', linkPath: null })).toBe('difft')
    expect(validateArchiveEntry({ path: 'nested', type: 'Directory', linkPath: null })).toBe('nested')
    expect(validateArchiveEntry({ path: 'e\u0301', type: 'File', linkPath: null })).toBe('e\u0301')
  })

  it('extracts the three expected regular files through staging and atomically replaces the destination', async () => {
    const difftArchive = await createArchive('safe-difft', ['difft'], async (source) => {
      await writeFile(join(source, 'difft'), 'difft binary')
    })
    const ripgrepArchive = await createArchive('safe-ripgrep', ['rg', 'ripgrep.node'], async (source) => {
      await writeFile(join(source, 'rg'), 'rg binary')
      await writeFile(join(source, 'ripgrep.node'), 'native module')
    })
    const destination = join(root, 'destination')
    await mkdir(destination)
    await writeFile(join(destination, 'previous'), 'replace me')

    await extractTarArchivesSafely({
      archives: [difftArchive, ripgrepArchive],
      destination,
      expectedFiles: ['difft', 'rg', 'ripgrep.node'],
    })

    expect(await readFile(join(destination, 'difft'), 'utf8')).toBe('difft binary')
    expect(await readFile(join(destination, 'rg'), 'utf8')).toBe('rg binary')
    expect(await readFile(join(destination, 'ripgrep.node'), 'utf8')).toBe('native module')
    expect((await lstat(join(destination, 'difft'))).isFile()).toBe(true)
    await expect(lstat(join(destination, 'previous'))).rejects.toThrow()
  })

  it('rejects a real symbolic-link archive without changing outside or existing files', async () => {
    const archive = await createArchive('symlink', ['difft'], async (source) => {
      await symlink('../outside-sentinel', join(source, 'difft'))
    })

    await expectRejectedWithoutOutsideWrite([archive], ['difft'], /unsupported archive entry type/i)
  })

  it('rejects a real hard-link archive without changing outside or existing files', async () => {
    const archive = await createArchive('hardlink', ['rg', 'difft'], async (source) => {
      await writeFile(join(source, 'rg'), 'shared inode')
      await link(join(source, 'rg'), join(source, 'difft'))
    })

    await expectRejectedWithoutOutsideWrite([archive], ['rg', 'difft'], /unsupported archive entry type/i)
  })

  it('rejects duplicate expected binaries without changing outside or existing files', async () => {
    const first = await createArchive('duplicate-one', ['difft'], async (source) => {
      await writeFile(join(source, 'difft'), 'first')
    })
    const second = await createArchive('duplicate-two', ['difft'], async (source) => {
      await writeFile(join(source, 'difft'), 'second')
    })

    await expectRejectedWithoutOutsideWrite([first, second], ['difft'], /exactly once|duplicate/i)
  })

  it('rejects unexpected regular files without changing outside or existing files', async () => {
    const archive = await createArchive('unexpected', ['difft', 'notes.txt'], async (source) => {
      await writeFile(join(source, 'difft'), 'binary')
      await writeFile(join(source, 'notes.txt'), 'not allowed')
    })

    await expectRejectedWithoutOutsideWrite([archive], ['difft'], /unexpected regular file/i)
  })
})
