/**
 * Executes the generated Windows tree-scan PowerShell under Docker pwsh.
 * Mocks agree with themselves; this is the structural antidote to #1911 B1
 * (CIM failure looking like a healthy childless root).
 *
 * Locally: skips when docker/image missing.
 * In CI (`CI=true`): fails hard — silent skip is fake coverage (#1911 Overseer).
 */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { windowsProcessListCimCommand, windowsProcessTreeCimCommand } from './process'

const POWERSHELL_IMAGE = 'mcr.microsoft.com/powershell:latest'

function dockerPwshAvailable(): boolean {
    try {
        execFileSync('docker', ['image', 'inspect', POWERSHELL_IMAGE], {
            stdio: 'ignore',
        })
        return true
    } catch {
        return false
    }
}

function ensureDockerPwsh(): void {
    if (dockerPwshAvailable()) return
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
        throw new Error(
            `CI requires ${POWERSHELL_IMAGE} for windowsProcessTree.pwsh.test.ts — `
            + 'pull it in the workflow before bun run test (silent skip is not coverage)'
        )
    }
}

function runPwsh(script: string): { status: number; stdout: string; stderr: string } {
    try {
        const stdout = execFileSync(
            'docker',
            ['run', '--rm', POWERSHELL_IMAGE, 'pwsh', '-NoProfile', '-Command', script],
            { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
        )
        return { status: 0, stdout: stdout.toString(), stderr: '' }
    } catch (error) {
        const err = error as { status?: number; stdout?: string; stderr?: string }
        return {
            status: typeof err.status === 'number' ? err.status : 1,
            stdout: err.stdout?.toString() ?? '',
            stderr: err.stderr?.toString() ?? '',
        }
    }
}

ensureDockerPwsh()
const describePwsh = dockerPwshAvailable() ? describe : describe.skip

describePwsh('windowsProcessTreeCimCommand under real pwsh (#1911 B1)', () => {
    it('fails closed when Get-CimInstance is missing (Linux container)', () => {
        // Measured pre-fix: SilentlyContinue printed root-only with exit 0.
        const result = runPwsh(windowsProcessTreeCimCommand(1234))
        expect(result.status).not.toBe(0)
        expect(result.stdout.trim()).not.toMatch(/^OK:/)
        expect(result.stdout.trim()).not.toBe('1234')
    })

    it('emits OK: children-first tree when Get-CimInstance is mocked healthy', () => {
        const mock = `
function Get-CimInstance {
  param($ClassName, $Filter)
  $ppid = [int](($Filter -split "=")[1])
  if ($ppid -eq 1234) {
    [pscustomobject]@{ ProcessId = 2000 }
    [pscustomobject]@{ ProcessId = 3000 }
  } elseif ($ppid -eq 2000) {
    [pscustomobject]@{ ProcessId = 4000 }
  }
}
${windowsProcessTreeCimCommand(1234)}
`
        const result = runPwsh(mock)
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('OK:4000,3000,2000,1234')
    })

    it('emits OK:root alone when the mocked tree has no children', () => {
        const mock = `
function Get-CimInstance { param($ClassName, $Filter) }
${windowsProcessTreeCimCommand(1234)}
`
        const result = runPwsh(mock)
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('OK:1234')
    })

    it('list command fails closed when Get-CimInstance is missing', () => {
        const result = runPwsh(windowsProcessListCimCommand())
        expect(result.status).not.toBe(0)
        expect(result.stdout.trim()).toBe('')
    })
})
