import { describe, expect, it } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { chmod, link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getOrCreateJsonFile } from './generators'

const itWithPosixNodes = process.platform === 'win32' ? it.skip : it
const itWithImmutableFlags = process.platform === 'darwin' ? it : it.skip

function fixture(filePath: string) {
    return {
        filePath,
        readValue: (raw: string) => (JSON.parse(raw) as { value: string }).value,
        writeValue: (value: string) => JSON.stringify({ value }),
        generate: () => 'generated-value',
        fileMode: 0o600,
        dirMode: 0o700,
    }
}

describe('getOrCreateJsonFile private-file boundary', () => {
    it('creates one private file and reuses it on reopen', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-create-'))
        try {
            const dataDir = join(dir, 'data')
            const secret = join(dataDir, 'secret.json')

            expect(await getOrCreateJsonFile(fixture(secret)))
                .toEqual({ value: 'generated-value', created: true })
            expect(await getOrCreateJsonFile(fixture(secret)))
                .toEqual({ value: 'generated-value', created: false })
            if (process.platform !== 'win32') {
                expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
                expect((await stat(secret)).mode & 0o777).toBe(0o600)
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('does not publish the final path until serialized contents are complete', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-publication-'))
        const secret = join(dir, 'secret.json')
        const moduleUrl = new URL('./generators.ts', import.meta.url).href
        const payloadBytes = 16 * 1024 * 1024
        const code = [
            'import { getOrCreateJsonFile } from ' + JSON.stringify(moduleUrl),
            "const payload = 'x'.repeat(" + payloadBytes + ')',
            'await getOrCreateJsonFile({',
            '  filePath: process.env.TARGET,',
            '  readValue: (raw) => JSON.parse(raw).value,',
            '  writeValue: (value) => JSON.stringify({ value }),',
            '  generate: () => payload,',
            '  fileMode: 0o600,',
            '  dirMode: 0o700,',
            '})',
        ].join('\n')
        const child = spawn(process.execPath, ['-e', code], {
            env: { ...process.env, TARGET: secret },
            stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        const completion = new Promise<number | null>((resolve) => {
            child.once('exit', resolve)
        })

        try {
            const deadline = Date.now() + 10_000
            while (!existsSync(secret) && Date.now() < deadline) {}

            expect(existsSync(secret)).toBe(true)
            const observed = JSON.parse(readFileSync(secret, 'utf8')) as { value: string }
            expect(observed.value).toHaveLength(payloadBytes)
            expect(await completion).toBe(0)
            expect(stderr).toBe('')
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL')
                await completion
            }
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('uses exclusive creation when several callers race for one secret', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-race-'))
        try {
            const secret = join(dir, 'secret.json')
            const racingFixture = {
                ...fixture(secret),
                generate: () => randomUUID(),
            }
            const results = await Promise.all(
                Array.from({ length: 12 }, () => getOrCreateJsonFile(racingFixture)),
            )

            expect(results.filter((result) => result.created)).toHaveLength(1)
            const values = new Set(results.map((result) => result.value))
            expect(values.size).toBe(1)
            expect(JSON.parse(await readFile(secret, 'utf8')).value).toBe([...values][0])
            expect(await readdir(dir)).toEqual(['secret.json'])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('returns the one published value when independent processes race', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-process-race-'))
        try {
            const secret = join(dir, 'secret.json')
            const moduleUrl = new URL('./generators.ts', import.meta.url).href
            const code = [
                'import { randomUUID } from "node:crypto"',
                'import { getOrCreateJsonFile } from ' + JSON.stringify(moduleUrl),
                'const result = await getOrCreateJsonFile({',
                '  filePath: process.env.TARGET,',
                '  readValue: (raw) => JSON.parse(raw).value,',
                '  writeValue: (value) => JSON.stringify({ value }),',
                '  generate: () => randomUUID(),',
                '  fileMode: 0o600,',
                '  dirMode: 0o700,',
                '})',
                'console.log(JSON.stringify(result))',
            ].join('\n')
            const launch = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
                const child = spawn(process.execPath, ['-e', code], {
                    env: { ...process.env, TARGET: secret },
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
                let stdout = ''
                let stderr = ''
                child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
                child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
                child.once('close', (exitCode) => resolve({ code: exitCode, stdout, stderr }))
            })

            const outcomes = await Promise.all(Array.from({ length: 8 }, launch))
            for (const outcome of outcomes) {
                expect(outcome.code, outcome.stderr).toBe(0)
            }
            const results = outcomes.map((outcome) => (
                JSON.parse(outcome.stdout) as { value: string; created: boolean }
            ))
            expect(results.filter((result) => result.created)).toHaveLength(1)
            const values = new Set(results.map((result) => result.value))
            expect(values.size).toBe(1)
            expect(JSON.parse(await readFile(secret, 'utf8')).value).toBe([...values][0])
            expect(await readdir(dir)).toEqual(['secret.json'])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithPosixNodes('rejects a symbolic-link secret instead of following it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-symlink-'))
        try {
            const target = join(dir, 'attacker-known.json')
            const secret = join(dir, 'secret.json')
            await writeFile(target, JSON.stringify({ value: 'attacker-known-value' }))
            await symlink(target, secret)

            await expect(getOrCreateJsonFile(fixture(secret))).rejects.toThrow(/Unsafe private file/)
            expect(await readFile(target, 'utf8')).toContain('attacker-known-value')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithPosixNodes('rejects a multiply linked secret file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-hardlink-'))
        try {
            const target = join(dir, 'attacker-known.json')
            const secret = join(dir, 'secret.json')
            await writeFile(target, JSON.stringify({ value: 'attacker-known-value' }))
            await link(target, secret)

            await expect(getOrCreateJsonFile(fixture(secret))).rejects.toThrow(/Unsafe private file/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithPosixNodes('rejects a symbolic-link parent directory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-parent-'))
        try {
            const realData = join(dir, 'attacker-data')
            const linkedData = join(dir, 'hapi-data')
            await mkdir(realData)
            await symlink(realData, linkedData)

            await expect(getOrCreateJsonFile(fixture(join(linkedData, 'secret.json'))))
                .rejects.toThrow(/Unsafe private directory/)
            await expect(readFile(join(realData, 'secret.json'), 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithPosixNodes('rejects a FIFO without blocking the process', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-fifo-'))
        try {
            const fifo = join(dir, 'secret.json')
            execFileSync('mkfifo', [fifo])
            const moduleUrl = new URL('./generators.ts', import.meta.url).href
            const code = [
                'import { getOrCreateJsonFile } from ' + JSON.stringify(moduleUrl),
                'await getOrCreateJsonFile({',
                '  filePath: process.env.TARGET,',
                '  readValue: (raw) => JSON.parse(raw).value,',
                '  writeValue: (value) => JSON.stringify({ value }),',
                "  generate: () => 'generated-value',",
                '})',
            ].join('\n')
            const child = spawn(process.execPath, ['-e', code], {
                env: { ...process.env, TARGET: fifo },
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            let stderr = ''
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString()
            })
            const completion = new Promise<{ timedOut: false; code: number | null }>((resolve) => {
                child.once('exit', (exitCode) => resolve({ timedOut: false, code: exitCode }))
            })
            const outcome = await Promise.race([
                completion,
                new Promise<{ timedOut: true }>((resolve) => {
                    setTimeout(() => resolve({ timedOut: true }), 1_000)
                }),
            ])
            if (outcome.timedOut) {
                child.kill('SIGKILL')
                await completion
            }

            expect(outcome.timedOut).toBe(false)
            if (!outcome.timedOut) {
                expect(outcome.code).not.toBe(0)
            }
            expect(stderr).toContain('Unsafe private file')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithPosixNodes('repairs the private parent and file modes before reading', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-modes-'))
        try {
            const dataDir = join(dir, 'data')
            const secret = join(dataDir, 'secret.json')
            await mkdir(dataDir, { mode: 0o777 })
            await chmod(dataDir, 0o777)
            await writeFile(secret, JSON.stringify({ value: 'existing-value' }), { mode: 0o666 })
            await chmod(secret, 0o666)

            const result = await getOrCreateJsonFile(fixture(secret))

            expect(result).toEqual({ value: 'existing-value', created: false })
            expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
            expect((await stat(secret)).mode & 0o777).toBe(0o600)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    itWithImmutableFlags('fails closed when private-file mode repair is rejected', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-json-secret-chmod-failure-'))
        try {
            const secret = join(dir, 'secret.json')
            await writeFile(secret, JSON.stringify({ value: 'known-value' }), { mode: 0o644 })
            await chmod(secret, 0o644)
            execFileSync('chflags', ['uchg', secret])
            try {
                await expect(getOrCreateJsonFile(fixture(secret))).rejects.toMatchObject({ code: 'EPERM' })
            } finally {
                execFileSync('chflags', ['nouchg', secret])
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
