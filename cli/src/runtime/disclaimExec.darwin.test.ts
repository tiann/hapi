/**
 * Real re-exec through bun:ffi on macOS, in dev mode (bun runs the fixtures):
 * same pid, own responsible process, stdio pipe, process group, env and cwd
 * preserved, fail-open without the private symbol, a request addressed to
 * another process ignored, and a binary without the hook ignoring the request.
 * The compiled binary needs a separate smoke test on a Mac. LAN access itself
 * needs a LAN peer and is not exercised here. Needs HAPI_BUN_EXEC from the test
 * setup.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DISCLAIM_RESPONSIBILITY_ENV } from './disclaimExec'

const reexecEntry = resolve(__dirname, '__fixtures__/reexecEntry.ts')
const withoutHook = resolve(__dirname, '__fixtures__/reportResponsibility.ts')

interface RunResult {
    spawnedPid: number | undefined
    code: number | null
    stdout: string
    stderr: string
}

// The spawned bun process is a direct child of this test process.
function run(args: string[], cwd: string, request: boolean | string): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, HAPI_DISCLAIM_TEST_PROBE: 'kept as is' }
    if (request !== false) {
        env[DISCLAIM_RESPONSIBILITY_ENV] = request === true ? String(process.pid) : request
    } else {
        delete env[DISCLAIM_RESPONSIBILITY_ENV]
    }
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.env.HAPI_BUN_EXEC!, args, {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('error', reject)
        child.on('exit', (code) => resolvePromise({ spawnedPid: child.pid, code, stdout, stderr }))
    })
}

describe.runIf(process.platform === 'darwin')('macOS responsibility re-exec', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hapi-disclaim-')))
    afterAll(() => rmSync(cwd, { recursive: true, force: true }))

    it('re-executes in place as its own responsible process, keeping pid, pipe, group, env and cwd', async () => {
        const result = await run([reexecEntry, 'a b', 'c'], cwd, true)

        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr).toBe('')
        const report = JSON.parse(result.stdout)
        expect(report.pid).toBe(result.spawnedPid)
        expect(report.responsible).toBe(report.pid)
        expect(report.ownResponsible).toBe(true)
        expect(report.pgid).toBe(report.pid)
        expect(report.cwd).toBe(cwd)
        expect(report.probe).toBe('kept as is')
        expect(report.request).toBeNull()
        expect(report.fallbackNote).toBeNull()
        expect(report.args).toEqual(['a b', 'c'])
    })

    it('without a request the child keeps the spawner as responsible process', async () => {
        const result = await run([reexecEntry], cwd, false)

        expect(result.code, result.stderr).toBe(0)
        const report = JSON.parse(result.stdout)
        expect(report.responsible).not.toBe(report.pid)
        expect(report.ownResponsible).toBe(false)
    })

    it('ignores a request addressed to another process', async () => {
        const result = await run([reexecEntry], cwd, String(process.pid + 1))

        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr).toBe('')
        const report = JSON.parse(result.stdout)
        expect(report.responsible).not.toBe(report.pid)
        expect(report.request).toBeNull()
    })

    it('fails open to a plain exec when the disclaim symbol is missing, and leaves a note for the log', async () => {
        const result = await run([reexecEntry, '--missing-symbol'], cwd, true)

        expect(result.code, result.stderr).toBe(0)
        expect(result.stderr.trim().split('\n')).toEqual([
            '[hapi] macOS responsibility disclaim: disclaim symbol not found; executing without it'
        ])
        const report = JSON.parse(result.stdout)
        expect(report.pid).toBe(result.spawnedPid)
        expect(report.responsible).not.toBe(report.pid)
        expect(report.request).toBeNull()
        expect(report.fallbackNote).toBe('disclaim symbol not found')
        expect(report.probe).toBe('kept as is')
    })

    it('a binary without the hook ignores the request and runs normally (rollback)', async () => {
        const result = await run([withoutHook, 'x'], cwd, true)

        expect(result.code, result.stderr).toBe(0)
        const report = JSON.parse(result.stdout)
        expect(report.pid).toBe(result.spawnedPid)
        expect(report.responsible).not.toBe(report.pid)
        expect(report.args).toEqual(['x'])
    })
})
