import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readWindowsProcessTable, WINDOWS_PROCESS_TABLE_COMMAND } from './windowsProcessStop'

describe.skipIf(process.platform !== 'win32')('Windows native process snapshot', () => {
    it('runs the generated command under Windows PowerShell with matching generation markers', async () => {
        const table = await readWindowsProcessTable(15_000, [process.pid], true)
        expect(table).not.toBeNull()
        expect(table!.get(process.pid)?.marker).toMatch(/^\d{4}-\d\d-\d\dT/)
        expect(table!.get(process.pid)?.parentPid).toBeGreaterThanOrEqual(0)
        expect(table!.get(process.pid)?.name).toBeTruthy()
        const direct = await readWindowsProcessTable(15_000, [process.pid])
        expect(direct?.get(process.pid)?.marker).toBe(table!.get(process.pid)?.marker)
    }, 40_000)

    it('represents a missing process as a complete empty filtered snapshot', async () => {
        const table = await readWindowsProcessTable(15_000, [2147483647])
        expect(table).not.toBeNull()
        expect(table!.size).toBe(0)
    }, 20_000)

    it('exits unsuccessfully when CIM fails instead of emitting a partial success table', () => {
        const script = "function Get-CimInstance { throw 'simulated CIM failure' }\n" + WINDOWS_PROCESS_TABLE_COMMAND
        expect(() => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, timeout: 15_000, stdio: 'pipe',
        })).toThrow()
    }, 20_000)
})
