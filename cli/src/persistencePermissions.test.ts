import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function createHapiHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hapi-persistence-permissions-'))
  tempDirs.push(home)
  vi.stubEnv('HAPI_HOME', home)
  return home
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

async function runFifoReadInChild(home: string): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  timedOut: boolean
}> {
  const persistenceUrl = new URL('./persistence.ts', import.meta.url).href
  const script = `
    const persistence = await import(${JSON.stringify(persistenceUrl)});
    try {
      await persistence.readSettings();
      console.error('unexpected read success');
      process.exitCode = 2;
    } catch (error) {
      if (!/Unsafe private file/.test(String(error))) {
        console.error(error);
        process.exitCode = 3;
      }
    }
  `
  const child = spawn('bun', ['-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HAPI_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 750)
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  clearTimeout(timeout)
  return { code, signal, stderr, timedOut }
}

async function listenOnUnixSocket(path: string) {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return server
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('CLI persistence permissions', () => {
  it.skipIf(process.platform === 'win32')('does not follow a preplaced settings temp symlink', async () => {
    const home = createHapiHome()
    const outsideFile = join(home, 'outside-secret.txt')
    const temporaryFile = join(home, 'settings.json.tmp')
    writeFileSync(outsideFile, 'outside-sentinel', { mode: 0o600 })
    symlinkSync(outsideFile, temporaryFile)

    const { writeSettings } = await import('./persistence')
    await expect(writeSettings({ cliApiToken: 'must-not-escape' })).rejects.toThrow(/unsafe|symbolic/i)

    expect(readFileSync(outsideFile, 'utf8')).toBe('outside-sentinel')
    expect(lstatSync(temporaryFile).isSymbolicLink()).toBe(true)
  })

  it('repairs a legacy settings file to 0600 when it is read', async () => {
    const home = createHapiHome()
    const settingsFile = join(home, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ machineId: 'legacy' }), { mode: 0o644 })
    chmodSync(settingsFile, 0o644)

    const { readSettings } = await import('./persistence')
    await readSettings()

    expect(fileMode(settingsFile)).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a settings FIFO without blocking', async () => {
    const home = createHapiHome()
    execFileSync('mkfifo', [join(home, 'settings.json')])

    const result = await runFifoReadInChild(home)

    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBe(null)
    expect(result.code, result.stderr).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('rejects a settings directory', async () => {
    const home = createHapiHome()
    mkdirSync(join(home, 'settings.json'))

    const { readSettings } = await import('./persistence')
    await expect(readSettings()).rejects.toThrow(/unsafe|regular/i)
  })

  it.skipIf(process.platform === 'win32')('rejects a settings socket', async () => {
    const home = createHapiHome()
    const server = await listenOnUnixSocket(join(home, 'settings.json'))
    try {
      const { readSettings } = await import('./persistence')
      await expect(readSettings()).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a settings symlink', async () => {
    const home = createHapiHome()
    const outsideFile = join(home, 'outside-settings.json')
    writeFileSync(outsideFile, '{}', { mode: 0o600 })
    symlinkSync(outsideFile, join(home, 'settings.json'))

    const { readSettings } = await import('./persistence')
    await expect(readSettings()).rejects.toThrow(/unsafe|symbolic/i)
  })

  it.skipIf(process.platform === 'win32')('rejects a multiply linked settings file', async () => {
    const home = createHapiHome()
    const outsideFile = join(home, 'outside-settings.json')
    writeFileSync(outsideFile, '{}', { mode: 0o600 })
    linkSync(outsideFile, join(home, 'settings.json'))

    const { readSettings } = await import('./persistence')
    await expect(readSettings()).rejects.toThrow(/unsafe|regular/i)
  })

  it('repairs an orphaned settings temporary file even when the final file is absent', async () => {
    const home = createHapiHome()
    const temporaryFile = join(home, 'settings.json.tmp')
    writeFileSync(temporaryFile, JSON.stringify({ cliApiToken: 'orphaned-secret' }), { mode: 0o644 })
    chmodSync(temporaryFile, 0o644)

    const { readSettings } = await import('./persistence')
    await readSettings()

    expect(fileMode(temporaryFile)).toBe(0o600)
  })

  it('writes settings with mode 0600 even when the target was permissive', async () => {
    const home = createHapiHome()
    const settingsFile = join(home, 'settings.json')
    writeFileSync(settingsFile, '{}', { mode: 0o644 })
    chmodSync(settingsFile, 0o644)

    const { writeSettings } = await import('./persistence')
    await writeSettings({ machineId: 'written' })

    expect(fileMode(settingsFile)).toBe(0o600)
  })

  it('atomically updates settings through a 0600 temporary file', async () => {
    const home = createHapiHome()
    const settingsFile = join(home, 'settings.json')
    const temporaryFile = `${settingsFile}.tmp`
    writeFileSync(settingsFile, '{}', { mode: 0o600 })
    writeFileSync(temporaryFile, '{}', { mode: 0o644 })
    chmodSync(temporaryFile, 0o644)

    const { updateSettings } = await import('./persistence')
    await updateSettings((settings) => ({ ...settings, machineId: 'updated' }))

    expect(fileMode(settingsFile)).toBe(0o600)
  })

  it('writes the credential key file with mode 0600', async () => {
    const home = createHapiHome()

    const { writeCredentialsDataKey } = await import('./persistence')
    await writeCredentialsDataKey({
      publicKey: new Uint8Array([1]),
      machineKey: new Uint8Array([2]),
      token: 'credential-secret',
    })

    expect(fileMode(join(home, 'access.key'))).toBe(0o600)
  })
})
