import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, killMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    killMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return { ...actual, spawn: spawnMock }
})

vi.mock('../../utils/process', () => ({
    killProcessByChildProcess: killMock,
}))

import { _resetPiModelsCacheForTests, listPiModelsForMachine } from './piModels'

const PROBE_RPC_ID = 'hapi-machine-models-probe'

class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write: vi.fn() })
    pid: number | undefined = 4242
    kill = vi.fn()

    emitModelsResponse(models: Array<Record<string, unknown>>): void {
        this.stdout.emit('data', `${JSON.stringify({
            id: PROBE_RPC_ID,
            type: 'response',
            command: 'get_available_models',
            success: true,
            data: { models },
        })}\n`)
    }
}

let child: FakeChild

beforeEach(() => {
    _resetPiModelsCacheForTests()
    child = new FakeChild()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => child)
    killMock.mockReset()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('runPiModelsProbe spawn', () => {
    it('probes from the runner cwd so project-local providers stay visible', async () => {
        // A runner started inside a project must keep seeing that project's
        // .pi/extensions providers, which the replaced --list-models probe
        // also surfaced.
        killMock.mockResolvedValue(true)
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/work/project')

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        await pending

        expect(spawnMock).toHaveBeenCalledWith(
            'pi',
            expect.any(Array),
            expect.objectContaining({ cwd: '/work/project' }),
        )
        cwdSpy.mockRestore()
    })

    it('falls back to home when the runner cwd is a filesystem root', async () => {
        // Under launchd/systemd the runner cwd is `/`, where a Pi startup that
        // loads extensions took 16.8s locally and blew the 15s timeout on every
        // call (1.3s from home). No project exists at a root to lose.
        killMock.mockResolvedValue(true)
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(parse(process.cwd()).root)

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        await pending

        expect(spawnMock).toHaveBeenCalledWith(
            'pi',
            expect.any(Array),
            expect.objectContaining({ cwd: homedir() }),
        )
        cwdSpy.mockRestore()
    })

    it('falls back to home when the runner cwd cannot be resolved', async () => {
        // A deleted working directory makes process.cwd() throw; home always
        // resolves, so discovery must not die with it.
        killMock.mockResolvedValue(true)
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
            throw new Error('ENOENT: uv_cwd')
        })

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        await pending

        expect(spawnMock).toHaveBeenCalledWith(
            'pi',
            expect.any(Array),
            expect.objectContaining({ cwd: homedir() }),
        )
        cwdSpy.mockRestore()
    })

    it('keeps extensions enabled so registered providers still surface', async () => {
        // pi.registerProvider lets an extension contribute whole providers, and
        // the replaced `--list-models` probe listed those models.
        killMock.mockResolvedValue(true)

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        await pending

        const args = spawnMock.mock.calls[0]?.[1] as string[]
        expect(args).not.toContain('--no-extensions')
        expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--no-session']))
    })
})

describe('runPiModelsProbe teardown', () => {
    it('escalates to a forced kill when the graceful teardown reports survivors', async () => {
        killMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        const response = await pending

        expect(response.availableModels).toEqual([{ provider: 'p1', modelId: 'm1' }])
        expect(killMock).toHaveBeenNthCalledWith(1, child, false)
        expect(killMock).toHaveBeenNthCalledWith(2, child, true)
    })

    it('rejects and caches nothing when even the forced teardown fails', async () => {
        killMock.mockResolvedValue(false)

        const pending = listPiModelsForMachine()
        child.emitModelsResponse([{ id: 'm1', provider: 'p1' }])
        await expect(pending).rejects.toThrow(/could not be stopped/)

        // A surviving probe child must not leave a cached catalog behind: the
        // next call has to re-probe rather than serve a result that came with
        // an orphan.
        killMock.mockReset()
        killMock.mockResolvedValue(true)
        const secondChild = new FakeChild()
        spawnMock.mockImplementation(() => secondChild)

        const second = listPiModelsForMachine()
        secondChild.emitModelsResponse([{ id: 'm2', provider: 'p2' }])
        await expect(second).resolves.toMatchObject({
            availableModels: [{ provider: 'p2', modelId: 'm2' }],
        })
        expect(spawnMock).toHaveBeenCalledTimes(2)
    })

    it('does not report a teardown failure when the child never started', async () => {
        child.pid = undefined
        killMock.mockResolvedValue(false)

        const pending = listPiModelsForMachine()
        child.emit('error', new Error('spawn pi ENOENT'))

        // The spawn failure must survive as-is instead of being replaced by a
        // misleading "could not be stopped" error.
        await expect(pending).rejects.toThrow(/ENOENT/)
        expect(killMock).not.toHaveBeenCalled()
    })

    it('tears the tree down once on the timeout path', async () => {
        vi.useFakeTimers()
        killMock.mockResolvedValue(true)

        // Attach the rejection assertion before advancing timers so the
        // rejection can never escape as an unhandled one.
        const assertion = expect(listPiModelsForMachine()).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(15_000)
        await assertion
        expect(killMock).toHaveBeenCalledWith(child, false)
    })
})
