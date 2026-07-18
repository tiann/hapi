import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerBashHandlers } from './bash'
import { registerDirectoryHandlers } from './directories'
import { registerFileHandlers } from './files'
import { gitEnvironment, registerGitHandlers } from './git'
import { registerRipgrepHandlers } from './ripgrep'

type RpcResponse = {
  success: boolean
  content?: string
  stdout?: string
  stderr?: string
  error?: string
}

const itWithSymlinks = process.platform === 'win32' ? it.skip : it

describe('common handler working-directory boundary', () => {
  let parent: string
  let workingDirectory: string
  let outsideDirectory: string
  let outsideFile: string
  let fileLink: string
  let directoryLink: string
  let rpc: RpcHandlerManager

  async function request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const response = await rpc.handleRequest({
      method: `security:${method}`,
      params: JSON.stringify(params),
    })
    return JSON.parse(response) as RpcResponse
  }

  async function configureDirtySubmoduleFilter(
    kind: 'clean' | 'process',
    nested = false,
  ): Promise<string> {
    const filteredRepository = join(parent, `submodule-${kind}-filtered-source`)
    const helper = join(parent, `submodule-${kind}-filter-helper.sh`)
    const sentinel = join(parent, `submodule-${kind}-filter-invoked.txt`)
    const driver = `hapi-submodule-${kind}-probe`
    await mkdir(filteredRepository)
    execFileSync('git', ['init', '-q'], { cwd: filteredRepository })
    await writeFile(join(filteredRepository, '.gitattributes'), `*.txt filter=${driver}\n`)
    await writeFile(join(filteredRepository, 'tracked.txt'), 'aaaaaaaa\n')
    execFileSync('git', ['add', '.gitattributes', 'tracked.txt'], { cwd: filteredRepository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', `submodule ${kind} fixture`,
    ], { cwd: filteredRepository })

    let sourceRepository = filteredRepository
    let submodule = join(workingDirectory, 'submodule')
    if (nested) {
      sourceRepository = join(parent, `submodule-${kind}-container-source`)
      await mkdir(sourceRepository)
      execFileSync('git', ['init', '-q'], { cwd: sourceRepository })
      execFileSync('git', [
        '-c', 'protocol.file.allow=always',
        'submodule', 'add', '-q', filteredRepository, 'nested',
      ], { cwd: sourceRepository })
      execFileSync('git', ['add', '.gitmodules', 'nested'], { cwd: sourceRepository })
      execFileSync('git', [
        '-c', 'user.name=HAPI Test',
        '-c', 'user.email=hapi-test@example.invalid',
        'commit', '-q', '-m', `submodule ${kind} container fixture`,
      ], { cwd: sourceRepository })
      submodule = join(submodule, 'nested')
    }

    execFileSync('git', [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', sourceRepository, 'submodule',
    ], { cwd: workingDirectory })
    if (nested) {
      execFileSync('git', [
        '-c', 'protocol.file.allow=always',
        'submodule', 'update', '--init', '-q',
      ], { cwd: join(workingDirectory, 'submodule') })
    }
    execFileSync('git', ['add', '.gitmodules', 'submodule'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', `parent ${kind} fixture`,
    ], { cwd: workingDirectory })
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      kind === 'clean' ? 'cat' : 'exit 1',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', `filter.${driver}.${kind}`, helper], { cwd: submodule })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await writeFile(join(submodule, 'tracked.txt'), 'bbbbbbbb\n')
    return sentinel
  }

  async function configureLazyFetchRepository(
    name: string,
    mode: 'status' | 'unstaged' | 'staged',
  ): Promise<{ repository: string; sentinel: string; trackedFile: string }> {
    const repository = join(workingDirectory, name)
    const sentinel = join(parent, `${name}-lazy-fetch-invoked.txt`)
    const helper = join(parent, `${name}-lazy-fetch-ssh.sh`)
    const trackedFile = join(repository, 'tracked.txt')
    await mkdir(repository)
    execFileSync('git', ['init', '-q'], { cwd: repository })
    await writeFile(trackedFile, 'aaaaaaaa\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'lazy fetch fixture',
    ], { cwd: repository })
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked >> ${JSON.stringify(sentinel)}`,
      'exit 1',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'extensions.partialClone', 'origin'], { cwd: repository })
    execFileSync('git', ['config', 'remote.origin.promisor', 'true'], { cwd: repository })
    execFileSync('git', ['config', 'remote.origin.partialclonefilter', 'blob:none'], { cwd: repository })
    execFileSync('git', ['config', 'remote.origin.url', 'ssh://example.invalid/repository'], { cwd: repository })
    execFileSync('git', ['config', 'core.sshCommand', helper], { cwd: repository })

    let missingObject: string
    if (mode === 'status') {
      missingObject = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim()
      await writeFile(trackedFile, 'bbbbbbbb\n')
    } else {
      missingObject = execFileSync('git', ['rev-parse', 'HEAD:tracked.txt'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim()
      await writeFile(trackedFile, 'bbbbbbbb\n')
      if (mode === 'staged') execFileSync('git', ['add', 'tracked.txt'], { cwd: repository })
    }
    rmSync(join(repository, '.git', 'objects', missingObject.slice(0, 2), missingObject.slice(2)))
    return { repository, sentinel, trackedFile }
  }

  beforeEach(async () => {
    parent = mkdtempSync(join(tmpdir(), 'hapi-path-boundary-'))
    workingDirectory = join(parent, 'workspace')
    outsideDirectory = join(parent, 'outside')
    outsideFile = join(outsideDirectory, 'outside-secret.txt')
    fileLink = join(workingDirectory, 'outside-file-link')
    directoryLink = join(workingDirectory, 'outside-directory-link')

    await mkdir(join(workingDirectory, 'subdir'), { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(join(workingDirectory, 'inside.txt'), 'inside-original')
    await writeFile(join(workingDirectory, 'workspace-only-ripgrep-marker.txt'), 'workspace marker')
    await writeFile(outsideFile, 'outside-secret')
    if (process.platform !== 'win32') {
      await symlink(outsideFile, fileLink)
      await symlink(outsideDirectory, directoryLink)
    }
    execFileSync('git', ['init', '-q'], { cwd: workingDirectory })
    execFileSync('git', ['init', '-q'], { cwd: outsideDirectory })

    rpc = new RpcHandlerManager({ scopePrefix: 'security' })
    registerBashHandlers(rpc, workingDirectory)
    registerFileHandlers(rpc, workingDirectory)
    registerDirectoryHandlers(rpc, workingDirectory)
    registerRipgrepHandlers(rpc, workingDirectory)
    registerGitHandlers(rpc, workingDirectory)
  })

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true })
  })

  itWithSymlinks('rejects reading a file through a symlink that escapes the workspace', async () => {
    const response = await request('readFile', { path: fileLink })

    expect(response.success).toBe(false)
    expect(response.content).toBeUndefined()
  })

  itWithSymlinks('rejects listing a directory through a symlink that escapes the workspace', async () => {
    const response = await request('listDirectory', { path: directoryLink })

    expect(response.success).toBe(false)
  })

  itWithSymlinks('rejects updating a file through a symlink and leaves the outside file unchanged', async () => {
    const expectedHash = createHash('sha256').update('outside-secret').digest('hex')
    const response = await request('writeFile', {
      path: fileLink,
      content: Buffer.from('outside-overwritten').toString('base64'),
      expectedHash,
    })

    expect(response.success).toBe(false)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-secret')
  })

  itWithSymlinks('rejects creating a file below a symlinked parent directory', async () => {
    const outsideCreated = join(outsideDirectory, 'created-through-link.txt')
    const response = await request('writeFile', {
      path: join(directoryLink, 'created-through-link.txt'),
      content: Buffer.from('must-not-escape').toString('base64'),
    })

    expect(response.success).toBe(false)
    await expect(readFile(outsideCreated, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects ripgrep when its working directory is an escaping symlink', async () => {
    const response = await request('ripgrep', {
      args: ['--files'],
      cwd: directoryLink,
    })

    expect(response.success).toBe(false)
    expect(response.stdout ?? '').not.toContain('outside-secret.txt')
  })

  itWithSymlinks('rejects git when its working directory is an escaping symlink', async () => {
    const response = await request('git-status', { cwd: directoryLink })

    expect(response.success).toBe(false)
  })

  itWithSymlinks('rejects a git file path that traverses a symlink', async () => {
    const response = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: fileLink,
    })

    expect(response.success).toBe(false)
  })

  it('allows git to diff a deleted file whose parent directory is also gone', async () => {
    const removedDirectory = join(workingDirectory, 'removed-directory')
    await mkdir(removedDirectory)
    await writeFile(join(removedDirectory, 'deleted.txt'), 'deleted content\n')
    execFileSync('git', ['add', 'removed-directory/deleted.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: workingDirectory })
    rmSync(removedDirectory, { recursive: true, force: true })

    const response = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'removed-directory/deleted.txt',
    })

    expect(response.success).toBe(true)
    expect(response.stdout).toContain('deleted content')
  })

  it('anchors relative file updates to the session workspace', async () => {
    const expectedHash = createHash('sha256').update('inside-original').digest('hex')
    const response = await request('writeFile', {
      path: 'inside.txt',
      content: Buffer.from('inside-updated').toString('base64'),
      expectedHash,
    })

    expect(response.success).toBe(true)
    expect(await readFile(join(workingDirectory, 'inside.txt'), 'utf8')).toBe('inside-updated')
  })

  it('anchors a relative git cwd to the session workspace', async () => {
    const response = await request('git-status', { cwd: 'subdir' })

    expect(response.success).toBe(true)
  })

  it('allows git numstat when the repository is contained by the session workspace', async () => {
    execFileSync('git', ['add', 'inside.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: workingDirectory })
    await writeFile(join(workingDirectory, 'inside.txt'), 'inside changed\n')

    const response = await request('git-diff-numstat', { cwd: workingDirectory })

    expect(response.success).toBe(true)
    expect(response.stdout).toContain('inside.txt')
  })

  it('supports a contained repository whose index output exceeds the execFile default buffer', async () => {
    const emptyBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: workingDirectory,
      input: '',
      encoding: 'utf8',
    }).trim()
    const indexInfo = Array.from({ length: 22_000 }, (_, index) => (
      `100644 ${emptyBlob}\tlarge-index/directory-${String(index).padStart(5, '0')}/tracked-${String(index).padStart(5, '0')}.txt\n`
    )).join('')
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: workingDirectory,
      input: indexInfo,
      maxBuffer: 8 * 1024 * 1024,
    })

    const response = await request('git-status', { cwd: workingDirectory })

    expect(Buffer.byteLength(indexInfo)).toBeGreaterThan(1024 * 1024)
    expect(response.success).toBe(true)
  })

  itWithSymlinks('disables a repository-configured fsmonitor helper for git status', async () => {
    const helper = join(parent, 'fsmonitor-helper.sh')
    const sentinel = join(parent, 'fsmonitor-invoked.txt')
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      "printf '\\n'",
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'core.fsmonitor', helper], { cwd: workingDirectory })

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(true)
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('ignores caller-global content filters without executing them', async () => {
    const helper = join(parent, 'global-filter-helper.sh')
    const sentinel = join(parent, 'global-filter-invoked.txt')
    const globalConfig = join(parent, 'global-gitconfig')
    await writeFile(join(workingDirectory, '.gitattributes'), '*.txt filter=hapi-global-probe\n')
    await writeFile(join(workingDirectory, 'filtered.txt'), 'filtered original\n')
    execFileSync('git', ['add', '.gitattributes', 'filtered.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'global filter fixture',
    ], { cwd: workingDirectory })
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      'cat',
    ].join('\n'))
    await chmod(helper, 0o700)
    await writeFile(globalConfig, [
      '[filter "hapi-global-probe"]',
      `\tclean = ${helper}`,
    ].join('\n'))
    await writeFile(join(workingDirectory, 'filtered.txt'), 'filtered changed\n')

    const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      const response = await request('git-status', { cwd: workingDirectory })

      expect(response.success).toBe(true)
      await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig
    }
  })

  it('removes every ambient Git override before launching repository commands', () => {
    const hostileKeys = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_EXEC_PATH',
      'GIT_SSH_COMMAND',
      'GIT_ASKPASS',
      'GIT_NAMESPACE',
      'GIT_REPLACE_REF_BASE',
    ] as const
    const original = new Map(hostileKeys.map((key) => [key, process.env[key]]))
    for (const key of hostileKeys) process.env[key] = join(outsideDirectory, key.toLowerCase())

    try {
      const env = gitEnvironment()
      for (const key of hostileKeys) expect(env[key]).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBe('0')
      expect(env.GIT_CONFIG_GLOBAL).toBeTruthy()
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(env.GIT_NO_LAZY_FETCH).toBe('1')
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('removes ambient Git overrides regardless of environment-variable casing', () => {
    const hostileKeys = [
      'git_dir',
      'Git_Work_Tree',
      'gIt_InDeX_fIlE',
      'git_object_directory',
      'Git_Ssh_Command',
    ] as const
    const original = new Map(hostileKeys.map((key) => [key, process.env[key]]))
    for (const key of hostileKeys) process.env[key] = join(outsideDirectory, key.toLowerCase())

    try {
      const env = gitEnvironment()
      for (const key of hostileKeys) expect(env[key]).toBeUndefined()
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('ignores an inherited Git directory that redirects commands to a sibling repository', async () => {
    const sibling = join(parent, 'hostile-git-directory')
    await mkdir(sibling)
    execFileSync('git', ['init', '-q'], { cwd: sibling })
    await writeFile(join(sibling, 'sibling-only.txt'), 'sibling\n')
    execFileSync('git', ['add', 'sibling-only.txt'], { cwd: sibling })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'sibling fixture',
    ], { cwd: sibling })
    await writeFile(join(sibling, 'sibling-only.txt'), 'sibling changed\n')
    await writeFile(join(workingDirectory, 'inside.txt'), 'inside changed\n')

    const originalGitDir = process.env.GIT_DIR
    process.env.GIT_DIR = join(sibling, '.git')
    try {
      const response = await request('git-status', { cwd: workingDirectory })

      expect(response.success).toBe(true)
      expect(response.stdout).toContain('inside.txt')
      expect(response.stdout).not.toContain('sibling-only.txt')
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = originalGitDir
    }
  })

  itWithSymlinks('rejects repository-configured clean filters before git diff can execute them', async () => {
    const helper = join(parent, 'clean-filter-helper.sh')
    const sentinel = join(parent, 'clean-filter-invoked.txt')
    await writeFile(join(workingDirectory, '.gitattributes'), '*.txt filter=hapi-probe\n')
    await writeFile(join(workingDirectory, 'filtered.txt'), 'filtered original\n')
    execFileSync('git', ['add', '.gitattributes', 'filtered.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'filtered fixture',
    ], { cwd: workingDirectory })
    await writeFile(join(workingDirectory, 'filtered.txt'), 'filtered changed\n')
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      'cat',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'filter.hapi-probe.clean', helper], { cwd: workingDirectory })

    const numstat = await request('git-diff-numstat', { cwd: workingDirectory })
    const fileDiff = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'filtered.txt',
    })

    expect(numstat.success).toBe(false)
    expect(numstat.error).toBe('Git repository content filters are not allowed')
    expect(fileDiff.success).toBe(false)
    expect(fileDiff.error).toBe('Git repository content filters are not allowed')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects repository-configured clean filters before git status can execute them', async () => {
    const helper = join(parent, 'status-clean-filter-helper.sh')
    const sentinel = join(parent, 'status-clean-filter-invoked.txt')
    await writeFile(join(workingDirectory, '.gitattributes'), '*.status filter=hapi-status-probe\n')
    await writeFile(join(workingDirectory, 'filtered.status'), 'original\n')
    execFileSync('git', ['add', '.gitattributes', 'filtered.status'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'status-filter fixture',
    ], { cwd: workingDirectory })
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      'cat',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'filter.hapi-status-probe.clean', helper], { cwd: workingDirectory })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await writeFile(join(workingDirectory, 'filtered.status'), 'modified\n')

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git repository content filters are not allowed')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects repository-configured process filters before git diff can execute them', async () => {
    const helper = join(parent, 'process-filter-helper.sh')
    const sentinel = join(parent, 'process-filter-invoked.txt')
    await writeFile(join(workingDirectory, '.gitattributes'), '*.dat filter=hapi-process-probe\n')
    await writeFile(join(workingDirectory, 'filtered.dat'), 'filtered original\n')
    execFileSync('git', ['add', '.gitattributes', 'filtered.dat'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'process-filter fixture',
    ], { cwd: workingDirectory })
    await writeFile(join(workingDirectory, 'filtered.dat'), 'filtered changed\n')
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      'exit 1',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'filter.hapi-process-probe.process', helper], { cwd: workingDirectory })

    const response = await request('git-diff-numstat', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git repository content filters are not allowed')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('allows staged diffs without executing configured worktree filters', async () => {
    const helper = join(parent, 'staged-clean-filter-helper.sh')
    const sentinel = join(parent, 'staged-clean-filter-invoked.txt')
    await writeFile(join(workingDirectory, '.gitattributes'), '*.stage filter=hapi-staged-probe\n')
    await writeFile(join(workingDirectory, 'filtered.stage'), 'filtered original\n')
    execFileSync('git', ['add', '.gitattributes', 'filtered.stage'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'staged-filter fixture',
    ], { cwd: workingDirectory })
    await writeFile(join(workingDirectory, 'filtered.stage'), 'filtered staged\n')
    execFileSync('git', ['add', 'filtered.stage'], { cwd: workingDirectory })
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(sentinel)}`,
      'cat',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'filter.hapi-staged-probe.clean', helper], { cwd: workingDirectory })

    const numstat = await request('git-diff-numstat', { cwd: workingDirectory, staged: true })
    const fileDiff = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'filtered.stage',
      staged: true,
    })

    expect(numstat.success).toBe(true)
    expect(numstat.stdout).toContain('filtered.stage')
    expect(fileDiff.success).toBe(true)
    expect(fileDiff.stdout).toContain('filtered staged')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('disables lazy fetch helpers for status and staged or unstaged diffs', async () => {
    const statusFixture = await configureLazyFetchRepository('lazy-status', 'status')
    const unstagedFixture = await configureLazyFetchRepository('lazy-unstaged', 'unstaged')
    const stagedFixture = await configureLazyFetchRepository('lazy-staged', 'staged')

    const responses = [
      await request('git-status', { cwd: statusFixture.repository }),
      await request('git-diff-numstat', { cwd: unstagedFixture.repository }),
      await request('git-diff-file', {
        cwd: unstagedFixture.repository,
        filePath: unstagedFixture.trackedFile,
      }),
      await request('git-diff-numstat', { cwd: stagedFixture.repository, staged: true }),
      await request('git-diff-file', {
        cwd: stagedFixture.repository,
        filePath: stagedFixture.trackedFile,
        staged: true,
      }),
    ]

    for (const response of responses) expect(response.success).toBe(false)
    for (const fixture of [statusFixture, unstagedFixture, stagedFixture]) {
      await expect(readFile(fixture.sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  itWithSymlinks('allows a contained top-level worktree that rediscovers the same repository', async () => {
    const containedWorktree = join(workingDirectory, 'contained-worktree')
    await mkdir(containedWorktree)
    execFileSync('git', ['config', 'core.worktree', containedWorktree], { cwd: workingDirectory })
    await writeFile(join(containedWorktree, 'tracked.txt'), 'tracked\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'contained worktree fixture',
    ], { cwd: workingDirectory })

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(true)
  })

  itWithSymlinks('fails closed when the top-level worktree redirects discovery to a decoy repository', async () => {
    const decoyWorktree = join(workingDirectory, 'decoy-worktree')
    const helper = join(parent, 'top-level-decoy-clean-filter.sh')
    const sentinel = join(parent, 'top-level-decoy-filter-invoked.txt')
    await mkdir(decoyWorktree)
    await writeFile(helper, [
      '#!/bin/sh',
      `printf invoked >> ${JSON.stringify(sentinel)}`,
      'cat',
    ].join('\n'))
    await chmod(helper, 0o700)
    execFileSync('git', ['config', 'core.worktree', decoyWorktree], { cwd: workingDirectory })
    execFileSync('git', ['config', 'filter.hapi-top-level-decoy.clean', helper], { cwd: workingDirectory })
    await writeFile(join(decoyWorktree, '.gitattributes'), '*.dat filter=hapi-top-level-decoy\n')
    await writeFile(join(decoyWorktree, 'tracked.dat'), 'aaaaaaaa\n')
    execFileSync('git', ['add', '.gitattributes', 'tracked.dat'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'top-level decoy fixture',
    ], { cwd: workingDirectory })
    rmSync(sentinel, { force: true })
    execFileSync('git', ['init', '-q'], { cwd: decoyWorktree })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await writeFile(join(decoyWorktree, 'tracked.dat'), 'bbbbbbbb\n')

    const responses = [
      await request('git-status', { cwd: workingDirectory }),
      await request('git-diff-numstat', { cwd: workingDirectory }),
      await request('git-diff-file', { cwd: workingDirectory, filePath: 'tracked.dat' }),
    ]

    for (const response of responses) {
      expect(response.success).toBe(false)
      expect(response.error).toBe('Git repository configuration is unavailable')
    }
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('uses short pointer diffs for populated dirty submodules', async () => {
    const sourceRepository = join(parent, 'submodule-source')
    await mkdir(sourceRepository)
    execFileSync('git', ['init', '-q'], { cwd: sourceRepository })
    await writeFile(join(sourceRepository, 'tracked.txt'), 'aaaaaaaa\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: sourceRepository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'submodule fixture',
    ], { cwd: sourceRepository })
    execFileSync('git', [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', sourceRepository, 'submodule',
    ], { cwd: workingDirectory })
    execFileSync('git', ['add', '.gitmodules', 'submodule'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'parent fixture',
    ], { cwd: workingDirectory })
    execFileSync('git', ['config', 'diff.submodule', 'diff'], { cwd: workingDirectory })
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await writeFile(join(workingDirectory, 'submodule', 'tracked.txt'), 'bbbbbbbb\n')

    const response = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'submodule',
    })

    expect(response.success).toBe(true)
    expect(response.stdout).toContain('Subproject commit')
    expect(response.stdout).toContain('-dirty')
    expect(response.stdout).not.toContain('bbbbbbbb')
  })

  itWithSymlinks('allows Git operations with an uninitialized submodule', async () => {
    const sourceRepository = join(parent, 'uninitialized-submodule-source')
    await mkdir(sourceRepository)
    execFileSync('git', ['init', '-q'], { cwd: sourceRepository })
    await writeFile(join(sourceRepository, 'tracked.txt'), 'tracked\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: sourceRepository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'submodule fixture',
    ], { cwd: sourceRepository })
    execFileSync('git', [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', sourceRepository, 'submodule',
    ], { cwd: workingDirectory })
    execFileSync('git', ['add', '.gitmodules', 'submodule'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'parent fixture',
    ], { cwd: workingDirectory })
    execFileSync('git', ['submodule', 'deinit', '-f', '--', 'submodule'], { cwd: workingDirectory })

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(true)
  })

  itWithSymlinks('fails closed when a populated submodule redirects core.worktree', async () => {
    const sentinel = await configureDirtySubmoduleFilter('clean')
    const submodule = join(workingDirectory, 'submodule')
    const aliasedWorktree = join(workingDirectory, 'aliased-submodule-worktree')
    await mkdir(aliasedWorktree)
    await copyFile(join(submodule, '.gitattributes'), join(aliasedWorktree, '.gitattributes'))
    await copyFile(join(submodule, 'tracked.txt'), join(aliasedWorktree, 'tracked.txt'))
    execFileSync('git', ['config', 'core.worktree', aliasedWorktree], { cwd: submodule })

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git submodule configuration is unavailable')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects populated submodule clean filters before worktree Git operations', async () => {
    const sentinel = await configureDirtySubmoduleFilter('clean')

    const status = await request('git-status', { cwd: workingDirectory })
    const numstat = await request('git-diff-numstat', { cwd: workingDirectory })
    const fileDiff = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'submodule',
    })

    for (const response of [status, numstat, fileDiff]) {
      expect(response.success).toBe(false)
      expect(response.error).toBe('Git repository content filters are not allowed')
    }
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects populated submodule process filters before worktree Git operations', async () => {
    const sentinel = await configureDirtySubmoduleFilter('process')

    const status = await request('git-status', { cwd: workingDirectory })
    const numstat = await request('git-diff-numstat', { cwd: workingDirectory })
    const fileDiff = await request('git-diff-file', {
      cwd: workingDirectory,
      filePath: 'submodule',
    })

    for (const response of [status, numstat, fileDiff]) {
      expect(response.success).toBe(false)
      expect(response.error).toBe('Git repository content filters are not allowed')
    }
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('rejects filters configured in nested populated submodules', async () => {
    const sentinel = await configureDirtySubmoduleFilter('clean', true)

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git repository content filters are not allowed')
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('fails closed without exposing populated submodule configuration errors', async () => {
    const sentinel = await configureDirtySubmoduleFilter('clean')
    const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: join(workingDirectory, 'submodule'),
      encoding: 'utf8',
    }).trim()
    await writeFile(join(gitDirectory, 'config'), `[broken\nprivate = ${outsideFile}\n`)

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git submodule configuration is unavailable')
    expect(response.error).not.toContain(outsideFile)
    await expect(readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  itWithSymlinks('fails closed when gitlink discovery emits a non-UTF-8 path', async () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapperDirectory = join(parent, 'invalid-path-git-bin')
    const wrapper = join(wrapperDirectory, 'git')
    await mkdir(wrapperDirectory)
    await writeFile(wrapper, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = ls-files ]; then',
      "    printf '160000 0000000000000000000000000000000000000000 0\\tsub-\\377\\000'",
      '    exit 0',
      '  fi',
      'done',
      `exec ${JSON.stringify(realGit)} "$@"`,
    ].join('\n'))
    await chmod(wrapper, 0o700)
    const originalPath = process.env.PATH
    process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`
    try {
      const response = await request('git-status', { cwd: workingDirectory })

      expect(response.success).toBe(false)
      expect(response.error).toBe('Git submodule configuration is unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })

  itWithSymlinks('fails closed when gitlink discovery exceeds the repository-count budget', async () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapperDirectory = join(parent, 'excessive-gitlink-bin')
    const wrapper = join(wrapperDirectory, 'git')
    await mkdir(wrapperDirectory)
    await writeFile(wrapper, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = ls-files ]; then',
      '    index=0',
      '    while [ "$index" -le 256 ]; do',
      "      printf '160000 0000000000000000000000000000000000000000 0\\tmissing-%03d\\000' \"$index\"",
      '      index=$((index + 1))',
      '    done',
      '    exit 0',
      '  fi',
      'done',
      `exec ${JSON.stringify(realGit)} "$@"`,
    ].join('\n'))
    await chmod(wrapper, 0o700)
    const originalPath = process.env.PATH
    process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`
    try {
      const response = await request('git-status', { cwd: workingDirectory })

      expect(response.success).toBe(false)
      expect(response.error).toBe('Git submodule configuration is unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })

  itWithSymlinks('enforces one deadline across Git discovery and the final command', async () => {
    const wrapperDirectory = join(parent, 'slow-git-bin')
    const wrapper = join(wrapperDirectory, 'git')
    await mkdir(wrapperDirectory)
    await writeFile(wrapper, [
      '#!/bin/sh',
      'sleep 0.3',
      'case " $* " in',
      "  *' rev-parse --show-toplevel '*) pwd -P; exit 0 ;;",
      "  *' config '*) exit 1 ;;",
      "  *' ls-files '*) exit 0 ;;",
      "  *' status '*) exit 0 ;;",
      'esac',
      'exit 2',
    ].join('\n'))
    await chmod(wrapper, 0o700)
    const originalPath = process.env.PATH
    process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`
    try {
      const startedAt = Date.now()
      const response = await request('git-status', { cwd: workingDirectory, timeout: 1_000 })
      const elapsed = Date.now() - startedAt

      expect(response.success).toBe(false)
      expect(elapsed).toBeLessThan(1_600)
    } finally {
      process.env.PATH = originalPath
    }
  })

  itWithSymlinks('fails closed when populated repository depth exceeds the recursion budget', async () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapperDirectory = join(parent, 'deep-git-bin')
    const wrapper = join(wrapperDirectory, 'git')
    await mkdir(wrapperDirectory)
    await writeFile(wrapper, [
      '#!/bin/sh',
      'case " $* " in',
      "  *' rev-parse --show-toplevel '*) pwd -P; exit 0 ;;",
      "  *' config '*) exit 1 ;;",
      "  *' ls-files '*)",
      "    if [ -d child ]; then printf '160000 0000000000000000000000000000000000000000 0\\tchild\\000'; fi",
      '    exit 0 ;;',
      "  *' status '*) exit 0 ;;",
      'esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
    ].join('\n'))
    await chmod(wrapper, 0o700)
    let current = workingDirectory
    for (let depth = 0; depth < 33; depth += 1) {
      current = join(current, 'child')
      await mkdir(current)
    }
    const originalPath = process.env.PATH
    process.env.PATH = `${wrapperDirectory}:${originalPath ?? ''}`
    try {
      const response = await request('git-status', { cwd: workingDirectory })

      expect(response.success).toBe(false)
      expect(response.error).toBe('Git submodule configuration is unavailable')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('rejects git status when the repository root is outside the session workspace', async () => {
    const outerRepository = join(parent, 'outer-repository-status')
    const nestedWorkspace = join(outerRepository, 'nested-workspace')
    await mkdir(nestedWorkspace, { recursive: true })
    await writeFile(join(nestedWorkspace, 'inside.txt'), 'inside\n')
    await writeFile(join(outerRepository, 'outside-sibling.txt'), 'outside\n')
    execFileSync('git', ['init', '-q'], { cwd: outerRepository })
    execFileSync('git', ['add', '.'], { cwd: outerRepository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: outerRepository })
    await writeFile(join(outerRepository, 'outside-sibling.txt'), 'outside changed\n')

    rpc = new RpcHandlerManager({ scopePrefix: 'security' })
    registerGitHandlers(rpc, nestedWorkspace)
    const response = await request('git-status', { cwd: nestedWorkspace })

    expect(response.success).toBe(false)
    expect(response.error).toContain('repository root is outside the session workspace')
    expect(response.stdout ?? '').not.toContain('outside-sibling.txt')
  })

  it('rejects git numstat when the repository root is outside the session workspace', async () => {
    const outerRepository = join(parent, 'outer-repository-numstat')
    const nestedWorkspace = join(outerRepository, 'nested-workspace')
    await mkdir(nestedWorkspace, { recursive: true })
    await writeFile(join(nestedWorkspace, 'inside.txt'), 'inside\n')
    await writeFile(join(outerRepository, 'outside-sibling.txt'), 'outside\n')
    execFileSync('git', ['init', '-q'], { cwd: outerRepository })
    execFileSync('git', ['add', '.'], { cwd: outerRepository })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'fixture',
    ], { cwd: outerRepository })
    await writeFile(join(outerRepository, 'outside-sibling.txt'), 'outside changed\n')

    rpc = new RpcHandlerManager({ scopePrefix: 'security' })
    registerGitHandlers(rpc, nestedWorkspace)
    const response = await request('git-diff-numstat', { cwd: nestedWorkspace })

    expect(response.success).toBe(false)
    expect(response.error).toContain('repository root is outside the session workspace')
    expect(response.stdout ?? '').not.toContain('outside-sibling.txt')
  })

  it('does not relay a rev-parse error that names an outside repository path', async () => {
    const missingGitDirectory = join(outsideDirectory, 'missing-private-repository.git')
    rmSync(join(workingDirectory, '.git'), { recursive: true, force: true })
    await writeFile(join(workingDirectory, '.git'), `gitdir: ${missingGitDirectory}\n`)

    const response = await request('git-status', { cwd: workingDirectory })

    expect(response.success).toBe(false)
    expect(response.error).toBe('Git repository is unavailable')
    expect(response.error).not.toContain(missingGitDirectory)
  })

  it('does not relay final Git stderr that names an outside object directory', async () => {
    execFileSync('git', ['add', 'inside.txt'], { cwd: workingDirectory })
    execFileSync('git', [
      '-c', 'user.name=HAPI Test',
      '-c', 'user.email=hapi-test@example.invalid',
      'commit', '-q', '-m', 'final stderr fixture',
    ], { cwd: workingDirectory })
    const missingObjectDirectory = join(outsideDirectory, 'missing-private-objects')
    await writeFile(
      join(workingDirectory, '.git', 'objects', 'info', 'alternates'),
      `${missingObjectDirectory}\n`,
    )

    const responses = [
      await request('git-status', { cwd: workingDirectory }),
      await request('git-diff-numstat', { cwd: workingDirectory }),
      await request('git-diff-file', { cwd: workingDirectory, filePath: 'inside.txt' }),
    ]

    for (const response of responses) {
      expect(response.success).toBe(true)
      expect(response.stderr ?? '').not.toContain(missingObjectDirectory)
      expect(JSON.stringify(response)).not.toContain(missingObjectDirectory)
    }
  })

  it('uses the session workspace as ripgrep default cwd', async () => {
    const response = await request('ripgrep', { args: ['--files'] })

    expect(response.success).toBe(true)
    expect(response.stdout).toContain('workspace-only-ripgrep-marker.txt')
  })

  it('rejects ripgrep symlink-following flags', async () => {
    const response = await request('ripgrep', { args: ['--files', '--follow'] })

    expect(response.success).toBe(false)
  })

  it('rejects ripgrep path operands that could name a symlink', async () => {
    const response = await request('ripgrep', {
      args: ['--files', 'outside-directory-link'],
    })

    expect(response.success).toBe(false)
  })

  it('uses the session workspace as bash default cwd', async () => {
    const response = await request('bash', { command: 'pwd -P' })

    expect(response.success).toBe(true)
    expect(response.stdout?.trim()).toBe(await realpath(workingDirectory))
  })
})
