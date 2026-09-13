import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isProcessAlive, killProcessTreeByPid } from '@/utils/process'
import { PiTransport } from './piTransport'

let fixtureDirectory: string
let childPid: number | null = null

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const value = await read()
        if (value !== null) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Timed out waiting for the Pi shim child process')
}

describe.skipIf(process.platform !== 'win32')('PiTransport on Windows', () => {
    beforeAll(async () => {
        fixtureDirectory = await mkdtemp(join(process.cwd(), '.tmp-pi-transport-test-'))
        await writeFile(
            join(fixtureDirectory, 'pi-child.cjs'),
            "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)\n"
        )
        await writeFile(
            join(fixtureDirectory, 'pi-test.cmd'),
            `@echo off\r\n"${process.execPath}" "%~dp0pi-child.cjs" "%~dp0pi-child.pid"\r\n`
        )
    })

    afterAll(async () => {
        if (childPid && isProcessAlive(childPid)) {
            await killProcessTreeByPid(childPid, true)
        }
        await rm(fixtureDirectory, { recursive: true, force: true })
    })

    it('launches an npm-style .cmd shim and stops its process tree', async () => {
        const transport = new PiTransport({
            command: 'pi-test',
            args: [],
            cwd: fixtureDirectory,
            env: {
                ...process.env,
                PATH: fixtureDirectory,
                PATHEXT: '.CMD',
            },
        })

        const error = new Promise<never>((_, reject) => {
            transport.onError(reject)
        })

        transport.start()
        childPid = await Promise.race([
            waitFor(async () => {
                try {
                    return Number.parseInt(await readFile(join(fixtureDirectory, 'pi-child.pid'), 'utf8'), 10)
                } catch {
                    return null
                }
            }),
            error,
        ])
        expect(isProcessAlive(childPid)).toBe(true)

        await transport.kill()
        await waitFor(async () => isProcessAlive(childPid!) ? null : true)
        expect(isProcessAlive(childPid)).toBe(false)
    })
})
