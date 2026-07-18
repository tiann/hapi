import { lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, parse, posix, resolve } from 'node:path'
import * as tar from 'tar'

export type ArchiveEntryDescriptor = {
  path: string
  type: string
  linkPath: string | null
}

export type SafeTarExtractOptions = {
  archives: string[]
  destination: string
  expectedFiles: string[]
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/

export function validateArchiveEntry(entry: ArchiveEntryDescriptor): string {
  if (entry.type !== 'File' && entry.type !== 'Directory') {
    throw new Error(`Unsupported archive entry type: ${entry.type}`)
  }
  if (entry.linkPath !== null) {
    throw new Error('Archive link target is not allowed')
  }

  const archivePath = entry.path
  const segments = archivePath.split('/')
  if (
    archivePath.length === 0
    || archivePath.includes('\0')
    || archivePath.includes('\\')
    || posix.isAbsolute(archivePath)
    || archivePath.startsWith('//')
    || WINDOWS_DRIVE_PATH.test(archivePath)
    || posix.normalize(archivePath) !== archivePath
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(archivePath)}`)
  }

  return archivePath
}

function entryDescriptor(entry: {
  path: string
  type: string
  linkpath?: string
}): ArchiveEntryDescriptor {
  return {
    path: entry.path,
    type: entry.type,
    linkPath: entry.linkpath ?? null,
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function validateStagingTree(
  staging: string,
  expectedFiles: Set<string>,
): Promise<void> {
  const found = new Set<string>()

  async function walk(directory: string, prefix: string): Promise<void> {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`
      const absolutePath = join(directory, name)
      const stats = await lstat(absolutePath)
      if (stats.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (!stats.isFile()) {
        throw new Error(`Unsupported staged entry type: ${relativePath}`)
      }
      if (!expectedFiles.has(relativePath)) {
        throw new Error(`Unexpected regular file in archive: ${relativePath}`)
      }
      found.add(relativePath)
    }
  }

  await walk(staging, '')
  for (const expectedFile of expectedFiles) {
    if (!found.has(expectedFile)) {
      throw new Error(`Expected regular file is missing after extraction: ${expectedFile}`)
    }
  }
}

export async function extractTarArchivesSafely(options: SafeTarExtractOptions): Promise<void> {
  if (options.archives.length === 0) throw new Error('At least one archive is required')
  if (options.expectedFiles.length === 0) throw new Error('At least one expected file is required')

  const expectedFiles = new Set<string>()
  for (const expectedFile of options.expectedFiles) {
    const validated = validateArchiveEntry({ path: expectedFile, type: 'File', linkPath: null })
    if (expectedFiles.has(validated)) throw new Error(`Duplicate expected file: ${validated}`)
    expectedFiles.add(validated)
  }

  const expectedEntryCounts = new Map([...expectedFiles].map((path) => [path, 0]))
  for (const archive of options.archives) {
    let validationError: unknown = null
    await tar.list({
      file: archive,
      strict: true,
      onentry(entry) {
        if (validationError) return
        try {
          const archivePath = validateArchiveEntry(entryDescriptor(entry))
          if (entry.type === 'File' && expectedFiles.has(archivePath)) {
            expectedEntryCounts.set(archivePath, (expectedEntryCounts.get(archivePath) ?? 0) + 1)
          }
        } catch (error) {
          validationError = error
        }
      },
    })
    if (validationError) throw validationError
  }

  for (const [expectedFile, count] of expectedEntryCounts) {
    if (count !== 1) {
      throw new Error(`Expected file must occur exactly once across archives: ${expectedFile} (${count})`)
    }
  }

  const destination = resolve(options.destination)
  if (destination === parse(destination).root) throw new Error('Destination must not be a filesystem root')
  const parent = dirname(destination)
  const name = basename(destination)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, `.${name}.staging-`))
  let backupRoot: string | null = null
  let backupPath: string | null = null
  let destinationMoved = false
  let published = false

  try {
    const extractedEntryCounts = new Map([...expectedFiles].map((path) => [path, 0]))
    for (const archive of options.archives) {
      let validationError: unknown = null
      await tar.extract({
        file: archive,
        cwd: staging,
        strict: true,
        preserveOwner: false,
        filter(_path, entry) {
          try {
            const descriptor = entryDescriptor(entry as {
              path: string
              type: string
              linkpath?: string
            })
            const archivePath = validateArchiveEntry(descriptor)
            if (descriptor.type === 'File' && expectedFiles.has(archivePath)) {
              extractedEntryCounts.set(archivePath, (extractedEntryCounts.get(archivePath) ?? 0) + 1)
            }
            return true
          } catch (error) {
            validationError ??= error
            return false
          }
        },
      })
      if (validationError) throw validationError
    }

    for (const [expectedFile, count] of extractedEntryCounts) {
      if (count !== 1) {
        throw new Error(`Expected file must occur exactly once during extraction: ${expectedFile} (${count})`)
      }
    }
    await validateStagingTree(staging, expectedFiles)

    if (await pathExists(destination)) {
      backupRoot = await mkdtemp(join(parent, `.${name}.backup-`))
      backupPath = join(backupRoot, 'previous')
      await rename(destination, backupPath)
      destinationMoved = true
    }

    await rename(staging, destination)
    published = true

    if (backupRoot) {
      await rm(backupRoot, { recursive: true, force: true })
      backupRoot = null
      backupPath = null
      destinationMoved = false
    }
  } catch (error) {
    let restoreError: unknown = null
    if (!published && destinationMoved && backupPath) {
      try {
        await rename(backupPath, destination)
        destinationMoved = false
      } catch (candidate) {
        restoreError = candidate
      }
    }

    if (!published) await rm(staging, { recursive: true, force: true })
    if (backupRoot && !destinationMoved) {
      await rm(backupRoot, { recursive: true, force: true })
    }
    if (restoreError) {
      throw new AggregateError([error, restoreError], 'Safe extraction failed and destination restoration failed')
    }
    throw error
  }
}
