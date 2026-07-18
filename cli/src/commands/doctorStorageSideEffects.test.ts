import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-doctor-command-test-'))
    tempDirs.push(dir)
    return dir
}

describe('doctor storage command loading', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
        vi.resetModules()
        vi.doUnmock('@/ui/doctorStorage')
        vi.doUnmock('@/runner/doctor')
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('does not create HAPI_HOME while routing the storage dry-run command', async () => {
        const parent = makeTempDir()
        const hapiHome = join(parent, 'missing-hapi-home')
        const runDoctorStorageMock = vi.fn(async () => {})

        vi.stubEnv('HAPI_HOME', hapiHome)
        vi.doMock('@/ui/doctorStorage', () => ({
            runDoctorStorage: runDoctorStorageMock
        }))
        vi.doMock('@/runner/doctor', () => ({
            killRunawayHappyProcesses: vi.fn()
        }))

        const { doctorCommand } = await import('./doctor')

        await doctorCommand.run({
            args: ['doctor', 'storage', '--json'],
            subcommand: 'doctor',
            commandArgs: ['storage', '--json']
        })

        expect(runDoctorStorageMock).toHaveBeenCalledWith({ json: true, limit: undefined })
        expect(existsSync(hapiHome)).toBe(false)
    })

    it('does not create HAPI_HOME through the real CLI doctor storage entrypoint', () => {
        const parent = makeTempDir()
        const hapiHome = join(parent, 'missing-real-cli-hapi-home')

        const output = execFileSync('bun', ['src/index.ts', 'doctor', 'storage', '--json'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                HAPI_HOME: hapiHome
            },
            encoding: 'utf8',
            timeout: 10_000
        })
        const parsed = JSON.parse(output) as { db?: { exists?: boolean }; files?: unknown[] }

        expect(parsed.db?.exists).toBe(false)
        expect(parsed.files).toEqual([])
        expect(existsSync(hapiHome)).toBe(false)
    })
})
