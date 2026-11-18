import { expect, vi } from 'vitest'
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport'
import { isProcessAlive } from '@/utils/process'

const agentWithChild = `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    setInterval(() => {}, 1000); // Stay alive after stdin EOF.
    process.on('SIGTERM', () => {
        if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
        child.once('exit', () => process.exit(0));
    });
    createInterface({ input: process.stdin }).on('line', line => {
        const { id } = JSON.parse(line);
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result: [process.pid, child.pid] }));
    });
`

export async function expectAcpKill(
    kill: () => Promise<void>,
    disconnect: { mockImplementation: (implementation: () => Promise<void>) => unknown },
    running: Promise<'switch' | 'exit'>
): Promise<void> {
    const transport = await AcpStdioTransport.create({
        command: process.execPath,
        args: ['-e', agentWithChild]
    })
    const allowDisconnect = Promise.withResolvers<void>()
    const disconnectStarted = vi.fn()
    let closing: ReturnType<typeof transport.close> | undefined
    const close = () => closing ??= transport.close()
    disconnect.mockImplementation(async () => {
        disconnectStarted()
        await allowDisconnect.promise
        await close()
    })
    try {
        const result = await transport.sendRequest('test/processes', {}, { timeoutMs: 2_000 })
        expect(result).toEqual([expect.any(Number), expect.any(Number)])
        const pids = result as number[]
        expect(pids.every(isProcessAlive)).toBe(true)

        const settled = vi.fn()
        const killing = Promise.all([kill(), kill()]).then(settled)
        await vi.waitFor(() => expect(disconnectStarted).toHaveBeenCalledOnce())
        expect(settled).not.toHaveBeenCalled()
        allowDisconnect.resolve()
        await killing
        expect(pids.some(isProcessAlive)).toBe(false)
        await expect(running).resolves.toBe('exit')
        expect(disconnectStarted).toHaveBeenCalledOnce()
    } finally {
        allowDisconnect.resolve()
        await close()
    }
}
