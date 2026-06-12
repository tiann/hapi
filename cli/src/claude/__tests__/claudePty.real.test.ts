import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPtyManager } from '@/agent/AgentPtyManager'

async function waitForOutput(onData: ReturnType<typeof vi.fn>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (onData.mock.calls.length > 0) return
        await new Promise(r => setTimeout(r, 10))
    }
}

// Real PTY spawn requires the Bun runtime (Bun.spawn terminal). Vitest runs
// its test workers under Node, where Bun is undefined, so skip there. Run with
// the Bun runtime to exercise these.
describe.skipIf(typeof Bun === 'undefined')('claudePty real PTY', () => {
    let manager: AgentPtyManager

    afterEach(() => {
        manager?.kill()
    })

    it('onData fires for every write (messages 1, 2, 3)', async () => {
        manager = new AgentPtyManager()
        const onData = vi.fn()
        const onError = vi.fn((err: Error) => {
            console.error('[test] spawn error:', err.message)
        })

        manager.spawn({
            command: 'bash',
            args: ['-c', 'while IFS= read -r line; do echo "echo:$line"; done'],
            onData,
            onError,
        })

        expect(manager.isRunning).toBe(true)
        if (!manager.isRunning) {
            console.error('[test] manager not running, onError calls:', onError.mock.calls)
            return
        }

        manager.write('first\n')
        await waitForOutput(onData)
        expect(onData).toHaveBeenCalled()
        const firstCalls = onData.mock.calls.length
        const firstOutput = onData.mock.calls.map(c => c[0]).join('')
        expect(firstOutput).toContain('echo:first')
        onData.mockClear()

        manager.write('second\n')
        await waitForOutput(onData)
        expect(onData).toHaveBeenCalled()
        const secondOutput = onData.mock.calls.map(c => c[0]).join('')
        expect(secondOutput).toContain('echo:second')
        onData.mockClear()

        manager.write('third\n')
        await waitForOutput(onData)
        expect(onData).toHaveBeenCalled()
        const thirdOutput = onData.mock.calls.map(c => c[0]).join('')
        expect(thirdOutput).toContain('echo:third')
    })
})
