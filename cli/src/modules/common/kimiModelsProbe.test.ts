import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, configState } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    configState: { read: (() => ({ model: 'GLM-5.3-flash' })) as () => { model?: string } }
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))
vi.mock('@/kimi/utils/config', () => ({
    readKimiLocalConfig: () => configState.read()
}))

import { _resetKimiModelsCacheForTests, listKimiModelsForCwd } from './kimiModels'

class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    kill = vi.fn()
}

const MALFORMED_OUTPUT = '{"models":'

function startProbe(cwd: string) {
    const child = new FakeChild()
    spawnMock.mockImplementation(() => child)
    return { child, pending: listKimiModelsForCwd(cwd) }
}

beforeEach(() => {
    spawnMock.mockReset()
    configState.read = () => ({ model: 'GLM-5.3-flash' })
    _resetKimiModelsCacheForTests()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('Kimi provider list probe settlement', () => {
    it('reports malformed JSON at exit code 0 as a failure instead of throwing out of the callback', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-malformed')

        child.stdout.emit('data', MALFORMED_OUTPUT)
        child.emit('exit', 0, null)
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi provider list produced invalid JSON output'
        })
    })

    it('reports missing JSON output as a failure', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-no-json')

        child.stdout.emit('data', 'no json here')
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi provider list produced no JSON output'
        })
    })

    it('contains a throwing local-config read inside the probe promise', async () => {
        configState.read = () => {
            throw new Error('kimi config unreadable')
        }
        const { child, pending } = startProbe('/tmp/kimi-probe-config-throws')

        child.stdout.emit('data', JSON.stringify({ models: { 'alias-a': {} } }))
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi config unreadable'
        })
    })

    it('parses stdout that arrives after exit but before close', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-late-stdout')

        child.emit('exit', 0, null)
        child.stdout.emit('data', JSON.stringify({
            models: {
                'late-alias': { provider: 'p1', displayName: 'Late Model' }
            }
        }))
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: 'late-alias', name: 'Late Model', provider: 'p1' }],
            currentModelId: 'GLM-5.3-flash'
        })
    })

    it('keeps a non-zero exit a failure and prefers stderr', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-exit-1')

        child.stderr.emit('data', 'provider list unavailable\n')
        child.emit('close', 1, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'provider list unavailable'
        })
    })

    it('keeps a non-zero exit a failure when stderr is empty', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-exit-2')

        child.emit('close', 2, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi provider list exited with code 2'
        })
    })

    it('names the terminating signal when the probe dies without an exit code', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-signaled')

        child.emit('close', null, 'SIGKILL')

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'kimi provider list was terminated by SIGKILL'
        })
    })

    it('times the probe out and kills the child', async () => {
        vi.useFakeTimers()
        const { child, pending } = startProbe('/tmp/kimi-probe-timeout')

        await vi.advanceTimersByTimeAsync(15_000)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Kimi model discovery timed out'
        })
        expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('lets the first settlement win when an error is followed by a successful close', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-error-then-close')

        child.emit('error', new Error('spawn kimi ENOENT'))
        child.stdout.emit('data', JSON.stringify({ models: { 'alias-a': {} } }))
        child.emit('close', 0, null)

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'spawn kimi ENOENT'
        })
    })

    it('ignores a second close after the probe already settled', async () => {
        const { child, pending } = startProbe('/tmp/kimi-probe-double-close')

        child.stdout.emit('data', JSON.stringify({ models: { 'alias-a': { displayName: 'A' } } }))
        child.emit('close', 0, null)
        child.emit('close', 1, null)

        await expect(pending).resolves.toEqual({
            success: true,
            availableModels: [{ modelId: 'alias-a', name: 'A' }],
            currentModelId: 'GLM-5.3-flash'
        })
    })
})
