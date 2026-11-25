import React, { act } from 'react'
import { PassThrough } from 'node:stream'
import { render, type Instance } from 'ink'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAvailabilityEntry } from '@hapi/protocol'
import { AgentPicker } from './AgentPicker'

type InputHandler = (input: string, key: {
    ctrl?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean
}) => void
let inputHandler: InputHandler | null = null

vi.mock('ink', async (importOriginal) => ({
    ...await importOriginal<typeof import('ink')>(),
    useInput: (handler: InputHandler) => { inputHandler = handler }
}))

describe('agent picker', () => {
    let instance: Instance | undefined
    let output: string
    const onSelect = vi.fn()
    const onCancel = vi.fn()

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
        vi.clearAllMocks()
        inputHandler = null
        output = ''
    })

    afterEach(async () => {
        await act(async () => { instance?.unmount() })
        instance = undefined
        vi.unstubAllGlobals()
    })

    async function mount(agents: AgentAvailabilityEntry[]): Promise<void> {
        const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })
        const stdin = Object.assign(new PassThrough(), { isTTY: false })
        stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
        await act(async () => {
            instance = render(React.createElement(AgentPicker, { agents, onSelect, onCancel }), {
                stdout: stdout as unknown as NodeJS.WriteStream,
                stderr: stdout as unknown as NodeJS.WriteStream,
                stdin: stdin as unknown as NodeJS.ReadStream,
                // Ink buffers non-static output until unmount in CI; debug emits every frame.
                debug: true,
                patchConsole: false,
                exitOnCtrlC: false
            })
        })
    }

    async function press(key: Parameters<InputHandler>[1], input = ''): Promise<void> {
        if (!inputHandler) throw new Error('Input handler missing')
        await act(async () => { inputHandler?.(input, key) })
    }

    it('shows unavailable reasons and skips disabled agents during navigation', async () => {
        await mount([
            { agent: 'claude', available: false, reason: 'not_found' },
            { agent: 'codex', available: true },
            { agent: 'dsh', available: false, reason: 'invalid_configuration' },
            { agent: 'pi', available: true }
        ])

        expect(output).toContain('Claude (claude)')
        expect(output).toContain('not installed or not on PATH')
        expect(output).toContain('invalid configuration')
        expect(onSelect).not.toHaveBeenCalled()
        await press({ upArrow: true })
        await press({ return: true })
        expect(onSelect).toHaveBeenLastCalledWith('codex')
        await press({ downArrow: true })
        await press({ downArrow: true })
        await press({ return: true })
        expect(onSelect).toHaveBeenLastCalledWith('pi')
        await press({ upArrow: true })
        await press({ return: true })
        expect(onSelect).toHaveBeenLastCalledWith('codex')
    })

    it('requires confirmation even when only one agent is available', async () => {
        await mount([{ agent: 'codex', available: true }])
        expect(onSelect).not.toHaveBeenCalled()
        await press({ return: true })
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('codex')
    })

    it('cancels with Escape or Ctrl-C without selecting an agent', async () => {
        await mount([{ agent: 'codex', available: true }])
        await press({ escape: true })
        expect(onCancel).toHaveBeenLastCalledWith(0)
        await press({ ctrl: true }, 'c')
        expect(onCancel).toHaveBeenLastCalledWith(130)
        expect(onSelect).not.toHaveBeenCalled()
    })
})
