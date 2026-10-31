import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { findTestOwnedProcesses } from './auditTestProcesses'

/**
 * Runs a real marked child and verifies the audit scan recognizes it from the
 * live process table. Guards the macOS `ps` invocation: the bare `eww` form
 * (BSD-style, terminal-scoped) either exits 1 without a controlling terminal
 * or silently returns only the current session's processes, so the audit
 * misses orphaned children. The dashed `-eww` form scans the full table on
 * darwin and procps-ng alike.
 */
describe('findTestOwnedProcesses', () => {
    const children: ChildProcess[] = []

    function spawnMarkedChild(markerValue: string): ChildProcess {
        const child = spawn(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            {
                env: { ...process.env, HAPI_TEST_MARKER: markerValue },
                stdio: 'ignore',
            }
        )
        children.push(child)
        return child
    }

    afterEach(async () => {
        for (const child of children.splice(0)) {
            child.kill('SIGKILL')
            await new Promise<void>((resolve) => child.once('exit', () => resolve()))
        }
    })

    // Live process-table detection depends on `ps axeww`, which is not
    // available on Windows; the scan short-circuits to an empty list there, so
    // this assertion only applies on POSIX platforms.
    it.skipIf(process.platform === 'win32')('finds a live child carrying the marker in its environment', async () => {
        const markerValue = `MCK${process.pid}${Date.now()}`
        const child = spawnMarkedChild(markerValue)
        await new Promise<void>((resolve) => child.once('spawn', () => resolve()))

        const marker = `HAPI_TEST_MARKER=${markerValue}`
        let found = findTestOwnedProcesses(marker)
        // The scan runs immediately after spawn; allow a short settling window
        // for the process table to reflect the new child.
        const deadline = Date.now() + 2000
        while (found.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            found = findTestOwnedProcesses(marker)
        }

        expect(found).toHaveLength(1)
        expect(found[0]).toMatchObject({
            pid: child.pid,
            ppid: process.pid,
        })
        expect(found[0].rssKb).toBeGreaterThan(0)
        expect(found[0].command).not.toContain(`HAPI_TEST_MARKER=${markerValue}`)
    })

    it('returns an empty list when no process carries the marker', () => {
        expect(findTestOwnedProcesses(`HAPI_TEST_MARKER=nonexistent-${Date.now()}`)).toEqual([])
    })
})