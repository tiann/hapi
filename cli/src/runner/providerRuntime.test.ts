import { describe, expect, it } from 'vitest'
import { runBoundedProviderCommand } from './providerRuntime'

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitForDead(pid: number, timeoutMs = 1_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (!isAlive(pid)) return true
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return !isAlive(pid)
}

describe('bounded provider command runtime', () => {
    async function exerciseProcessTreeTeardown(
        trigger: 'timeout' | 'output-limit' | 'abort',
        parentIgnoresTerm = true,
    ) {
        const grandchildScript = [
            "process.on('SIGTERM', () => {})",
            "process.stdout.write('ready')",
            'setInterval(() => {}, 1000)',
        ].join(';')
        const parentScript = [
            "const { spawn } = require('node:child_process')",
            `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
            ...(parentIgnoresTerm ? ["process.on('SIGTERM', () => {})"] : []),
            "child.stdout.once('data', () => {",
            "process.stdout.write(JSON.stringify({ parent: process.pid, child: child.pid }) + '\\n')",
            ...(trigger === 'output-limit' ? ["process.stdout.write('x'.repeat(8192))"] : []),
            "})",
            'setInterval(() => {}, 1000)',
        ].join(';')
        let pids: { parent: number; child: number } | null = null

        try {
            const abortController = new AbortController()
            const abortTimer = trigger === 'abort'
                ? setTimeout(() => abortController.abort(), 500)
                : null
            const result = await runBoundedProviderCommand({
                command: process.execPath,
                args: ['-e', parentScript],
                env: stringEnv(process.env),
                timeoutMs: trigger === 'timeout' ? 1_000 : 5_000,
                maxOutputBytes: trigger === 'timeout' ? 4_096 : 256,
                signal: abortController.signal,
            })
            if (abortTimer) clearTimeout(abortTimer)
            pids = JSON.parse(result.stdout.split('\n')[0]!) as { parent: number; child: number }

            expect(result).toMatchObject(
                trigger === 'timeout'
                    ? { exitCode: null, timedOut: true }
                    : trigger === 'output-limit'
                        ? { exitCode: null, outputLimitExceeded: true }
                        : { exitCode: null, errorCode: 'ABORTED' }
            )
            await expect(waitForDead(pids.parent)).resolves.toBe(true)
            await expect(waitForDead(pids.child)).resolves.toBe(true)
        } finally {
            for (const pid of pids ? [pids.child, pids.parent] : []) {
                try {
                    process.kill(pid, 'SIGKILL')
                } catch {
                    // Already terminal.
                }
            }
        }
    }

    it.skipIf(process.platform === 'win32')('waits for timeout teardown of the whole provider process group', async () => {
        await exerciseProcessTreeTeardown('timeout')
    }, 10_000)

    it.skipIf(process.platform === 'win32')('waits for output-limit teardown of the whole provider process group', async () => {
        await exerciseProcessTreeTeardown('output-limit')
    }, 10_000)

    it.skipIf(process.platform === 'win32')('retains SIGKILL escalation after the direct parent exits on SIGTERM', async () => {
        await exerciseProcessTreeTeardown('timeout', false)
    }, 10_000)

    it.skipIf(process.platform === 'win32')('aborts and reaps the whole provider process group during runner shutdown', async () => {
        await exerciseProcessTreeTeardown('abort')
    }, 10_000)

    it('does not spawn a provider command when its lifecycle is already aborted', async () => {
        const abortController = new AbortController()
        abortController.abort()

        await expect(runBoundedProviderCommand({
            command: '/definitely/not/a/provider-command',
            args: [],
            env: stringEnv(process.env),
            timeoutMs: 5_000,
            maxOutputBytes: 256,
            signal: abortController.signal,
        })).resolves.toMatchObject({
            exitCode: null,
            errorCode: 'ABORTED',
        })
    })
})
