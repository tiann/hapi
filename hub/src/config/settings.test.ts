import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings, writeSettings } from './settings'

const tempDirs: string[] = []

function createSettingsPath(): string {
    const home = mkdtempSync(join(tmpdir(), 'hapi-hub-settings-permissions-'))
    tempDirs.push(home)
    return join(home, 'settings.json')
}

function fileMode(path: string): number {
    return statSync(path).mode & 0o777
}

async function runFifoReadInChild(settingsFile: string): Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stderr: string
    timedOut: boolean
}> {
    const settingsUrl = new URL('./settings.ts', import.meta.url).href
    const script = `
        const settings = await import(${JSON.stringify(settingsUrl)});
        try {
            await settings.readSettings(${JSON.stringify(settingsFile)});
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
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
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
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('Hub settings permissions', () => {
    it.skipIf(process.platform === 'win32')('does not follow a preplaced settings temp symlink', async () => {
        const settingsFile = createSettingsPath()
        const outsideFile = join(settingsFile, '..', 'outside-secret.txt')
        const temporaryFile = `${settingsFile}.tmp`
        writeFileSync(outsideFile, 'outside-sentinel', { mode: 0o600 })
        symlinkSync(outsideFile, temporaryFile)

        await expect(writeSettings(settingsFile, { cliApiToken: 'must-not-escape' })).rejects.toThrow(/unsafe|symbolic/i)

        expect(readFileSync(outsideFile, 'utf8')).toBe('outside-sentinel')
        expect(lstatSync(temporaryFile).isSymbolicLink()).toBe(true)
    })

    it('repairs a legacy settings file to 0600 when it is read', async () => {
        const settingsFile = createSettingsPath()
        writeFileSync(settingsFile, JSON.stringify({ cliApiToken: 'legacy-secret' }), { mode: 0o644 })
        chmodSync(settingsFile, 0o644)

        await readSettings(settingsFile)

        expect(fileMode(settingsFile)).toBe(0o600)
    })

    it.skipIf(process.platform === 'win32')('rejects a settings FIFO without blocking', async () => {
        const settingsFile = createSettingsPath()
        execFileSync('mkfifo', [settingsFile])

        const result = await runFifoReadInChild(settingsFile)

        expect(result.timedOut, result.stderr).toBe(false)
        expect(result.signal, result.stderr).toBe(null)
        expect(result.code, result.stderr).toBe(0)
    })

    it.skipIf(process.platform === 'win32')('rejects a settings directory', async () => {
        const settingsFile = createSettingsPath()
        mkdirSync(settingsFile)

        await expect(readSettings(settingsFile)).rejects.toThrow(/unsafe|regular/i)
    })

    it.skipIf(process.platform === 'win32')('rejects a settings socket', async () => {
        const settingsFile = createSettingsPath()
        const server = await listenOnUnixSocket(settingsFile)
        try {
            await expect(readSettings(settingsFile)).rejects.toThrow()
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })

    it.skipIf(process.platform === 'win32')('rejects a settings symlink', async () => {
        const settingsFile = createSettingsPath()
        const outsideFile = join(settingsFile, '..', 'outside-settings.json')
        writeFileSync(outsideFile, '{}', { mode: 0o600 })
        symlinkSync(outsideFile, settingsFile)

        await expect(readSettings(settingsFile)).rejects.toThrow(/unsafe|symbolic/i)
    })

    it.skipIf(process.platform === 'win32')('rejects a multiply linked settings file', async () => {
        const settingsFile = createSettingsPath()
        const outsideFile = join(settingsFile, '..', 'outside-settings.json')
        writeFileSync(outsideFile, '{}', { mode: 0o600 })
        linkSync(outsideFile, settingsFile)

        await expect(readSettings(settingsFile)).rejects.toThrow(/unsafe|regular/i)
    })

    it('repairs an orphaned settings temporary file even when the final file is absent', async () => {
        const settingsFile = createSettingsPath()
        const temporaryFile = `${settingsFile}.tmp`
        writeFileSync(temporaryFile, JSON.stringify({ cliApiToken: 'orphaned-secret' }), { mode: 0o644 })
        chmodSync(temporaryFile, 0o644)

        await readSettings(settingsFile)

        expect(fileMode(temporaryFile)).toBe(0o600)
    })

    it('writes settings through a 0600 temporary file', async () => {
        const settingsFile = createSettingsPath()
        const temporaryFile = `${settingsFile}.tmp`
        writeFileSync(temporaryFile, '{}', { mode: 0o644 })
        chmodSync(temporaryFile, 0o644)

        await writeSettings(settingsFile, { cliApiToken: 'written-secret' })

        expect(fileMode(settingsFile)).toBe(0o600)
    })
})
