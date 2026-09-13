import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CREATABLE_AGENT_FLAVORS, type AgentAvailabilityEntry, type AgentFlavor } from '@hapi/protocol'
import type { AgentPickerProps } from './ink/AgentPicker'

const { availabilityMock, renderMock, restoreMock } = vi.hoisted(() => ({
    availabilityMock: vi.fn<(agent: AgentFlavor) => AgentAvailabilityEntry>(),
    renderMock: vi.fn<(element: React.ReactElement<AgentPickerProps>, options: unknown) => {
        unmount: () => void
        waitUntilExit: () => Promise<void>
    }>(),
    restoreMock: vi.fn()
}))

vi.mock('@/agent/agentAvailability', () => ({ getAgentAvailability: availabilityMock }))
vi.mock('./terminalState', () => ({ restoreTerminalState: restoreMock }))
vi.mock('ink', async (importOriginal) => ({
    ...await importOriginal<typeof import('ink')>(),
    render: renderMock
}))

import { selectAgent } from './selectAgent'

describe('agent selection lifecycle', () => {
    const unmount = vi.fn()

    beforeEach(() => {
        vi.clearAllMocks()
        availabilityMock.mockImplementation((agent) => ({ agent, available: agent === 'codex' }))
        renderMock.mockImplementation(() => {
            let finish: () => void = () => {}
            const exited = new Promise<void>((resolve) => { finish = resolve })
            unmount.mockImplementation(finish)
            return { unmount, waitUntilExit: () => exited }
        })
    })

    it('lists all supported agents alphabetically and cleans up before returning the selection', async () => {
        const pending = selectAgent()
        const props = renderMock.mock.calls[0][0].props
        expect(props.agents.map((entry) => entry.agent)).toEqual([...CREATABLE_AGENT_FLAVORS].sort())
        expect(availabilityMock).toHaveBeenCalledWith('codex', process.env, 'terminal')
        expect(unmount).not.toHaveBeenCalled()

        props.onSelect('codex')
        // Repeated input cannot change an already confirmed selection.
        props.onCancel(130)
        expect(await pending).toEqual({ type: 'selected', agent: 'codex' })
        expect(restoreMock).toHaveBeenCalledOnce()
        expect(unmount.mock.invocationCallOrder[0]).toBeLessThan(restoreMock.mock.invocationCallOrder[0])
    })

    it.each([0, 130] as const)('cleans up on cancellation with code %s', async (exitCode) => {
        const pending = selectAgent()
        renderMock.mock.calls[0][0].props.onCancel(exitCode)
        expect(await pending).toEqual({ type: 'exit', exitCode })
        expect(unmount).toHaveBeenCalled()
        expect(restoreMock).toHaveBeenCalledOnce()
    })

    it('reports missing agents without mounting an empty picker', async () => {
        availabilityMock.mockImplementation((agent) => ({ agent, available: false, reason: 'not_found' }))
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            expect(await selectAgent()).toEqual({ type: 'exit', exitCode: 1 })
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No supported agents'))
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not installed or not on PATH'))
            expect(renderMock).not.toHaveBeenCalled()
        } finally {
            errorSpy.mockRestore()
        }
    })

    it('restores the terminal if Ink fails', async () => {
        renderMock.mockReturnValue({
            unmount,
            waitUntilExit: async () => { throw new Error('render failure') }
        })
        await expect(selectAgent()).rejects.toThrow('render failure')
        expect(unmount).toHaveBeenCalled()
        expect(restoreMock).toHaveBeenCalledOnce()
    })
})
